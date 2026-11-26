const config = require('../../config');
const { ensureGradleCompatibility } = require('../projectPrep');
const jobRegistry = require('../jobRegistry');
const { CancelledError } = jobRegistry;

function sh(value) {
  return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}

// Safely transport multiline shell scripts over SSH without quote parsing bugs.
function bashScriptCommand(script) {
  const encoded = Buffer.from(String(script || ''), 'utf8').toString('base64');
  return `bash -lc "printf %s ${encoded} | base64 -d | bash"`;
}

function formatCommandError(step, result) {
  const details = [result?.stderr, result?.stdout].filter(Boolean).join('\n').trim();
  if (!details) return `${step} failed`;
  return `${step} failed: ${details}`;
}

async function runGradleWithEnv(ssh, projectPath, commandBody, jobId) {
  if (jobId && jobRegistry.isCancelled(jobId)) {
    throw new CancelledError();
  }
  const script = `
set -e

if [ -z "$JAVA_HOME" ] && [ -d /usr/lib/jvm/java-17-openjdk-amd64 ]; then
  export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
fi
if [ -n "$JAVA_HOME" ]; then
  export PATH="$JAVA_HOME/bin:$PATH"
fi

if [ -z "$ANDROID_HOME" ]; then
  if [ -d /opt/android-sdk ]; then
    export ANDROID_HOME=/opt/android-sdk
  elif [ -d /usr/lib/android-sdk ]; then
    export ANDROID_HOME=/usr/lib/android-sdk
  fi
fi

if [ -n "$ANDROID_HOME" ]; then
  export ANDROID_SDK_ROOT="$ANDROID_HOME"
  export PATH="$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools"
  touch local.properties
  grep -v -E '^sdk.dir=' local.properties > local.properties.tmp || true
  { cat local.properties.tmp; echo "sdk.dir=$ANDROID_HOME"; } > local.properties
  rm -f local.properties.tmp
fi

chmod +x gradlew || true
${commandBody}
  `.trim();

  const execPromise = ssh.execCommand(bashScriptCommand(script), { cwd: projectPath });

  if (!jobId) {
    return execPromise;
  }

  const result = await Promise.race([
    execPromise,
    new Promise((resolve) => {
      const pollInterval = setInterval(() => {
        if (jobRegistry.isCancelled(jobId)) {
          clearInterval(pollInterval);
          resolve({ __cancelledWhileWaiting: true });
        }
      }, 1000);
      execPromise.finally(() => clearInterval(pollInterval)).catch(() => {});
    }),
  ]);

  if (result && result.__cancelledWhileWaiting) {
    throw new CancelledError();
  }

  if (jobRegistry.isCancelled(jobId)) {
    throw new CancelledError();
  }

  return result;
}

class AndroidPipeline {
  async run(ssh, worker, job, onProgress = () => {}) {
    const buildDir = worker.buildDir || config.workers.defaultBuildDir;
    const projectPath = job.projectPath || `${buildDir}/${job.jobId}`;

    try {
      await onProgress(22, 'Preparing Android project...');
      console.log(`[${job.jobId}] Step 0: Checking Gradle/AGP compatibility...`);
      await ensureGradleCompatibility(ssh, projectPath);
      console.log(`[${job.jobId}] Step 1: Cleaning...`);

      const clean = await runGradleWithEnv(ssh, projectPath, './gradlew clean', job.jobId);
      if (clean.code !== 0) throw new Error(formatCommandError('Gradle clean', clean));

      await onProgress(35, 'Resolving dependencies...');
      console.log(`[${job.jobId}] Step 2: Resolving dependencies during build...`);
      // Do not run the full `gradle dependencies` report; it is expensive and
      // unnecessary because assembleRelease/assembleDebug resolves everything.
      await onProgress(35, 'Dependencies ready; preparing Gradle build...');

      await onProgress(90, 'Building Android APK...');
      console.log(`[${job.jobId}] Step 3: Building APK (${job.buildType || 'release'})...`);
      
      const isDebug = job.buildType === 'debug';
      const buildCommand = isDebug
        ? './gradlew assembleDebug'
        : './gradlew assembleRelease';
      
      const buildApk = await runGradleWithEnv(ssh, projectPath, buildCommand, job.jobId);
      if (buildApk.code !== 0) throw new Error(formatCommandError('Gradle assemble', buildApk));

      const isRelease = !isDebug;
      const apkFileName = isDebug ? 'app-debug.apk' : 'app-release.apk';
      const expectedApkPath = `${projectPath}/app/build/outputs/apk/${isDebug ? 'debug' : 'release'}/${apkFileName}`;

      // DEBUG: List build directory structure
      console.log(`[${job.jobId}] DEBUG: Listing APK files in build directory...`);
      const listApkCmd = await ssh.execCommand(`find ${projectPath} -name "*.apk" -type f 2>/dev/null`);
      console.log(`[${job.jobId}] DEBUG: Found APK files:\n${listApkCmd.stdout || 'NONE'}`);

      // DEBUG: List outputs directory
      const listOutputsCmd = await ssh.execCommand(`ls -la ${projectPath}/app/build/outputs/apk/*/ 2>/dev/null || echo "Directory not found"`);
      console.log(`[${job.jobId}] DEBUG: Outputs directory:\n${listOutputsCmd.stdout || listOutputsCmd.stderr}`);

      // Try to find the actual APK file - handle different project structures
      // First try exact match
      const verifyApk = async (apkPath) => {
        if (!apkPath) return false;
        const r = await ssh.execCommand(`test -s ${sh(apkPath)} && stat -c%s ${sh(apkPath)} || echo 0`);
        const size = Number.parseInt(String(r.stdout || '').trim(), 10);
        if (!Number.isFinite(size) || size <= 0) return false;
        console.log(`[${job.jobId}] APK verified: ${apkPath} (${size} bytes)`);
        return true;
      };

      const findApkCmd = await ssh.execCommand(`find ${sh(projectPath)} -name ${sh(apkFileName)} -type f 2>/dev/null | head -1`);
      const actualApkPath = findApkCmd.stdout.trim();

      if (await verifyApk(actualApkPath)) {
        const integrity = await ssh.execCommand(`unzip -tq ${sh(actualApkPath)} >/dev/null 2>&1`);
        if (integrity.code !== 0) return { success: false, error: 'APK dibuat tetapi file tidak lolos pemeriksaan integrity.' };
        return { success: true, apkPath: actualApkPath };
      }

      // Fallback: try any APK file with release/debug suffix
      const fallbackPattern = isRelease ? '*release*.apk' : '*debug*.apk';
      const findAnyApkCmd = await ssh.execCommand(`find ${projectPath} -name "${fallbackPattern}" -type f 2>/dev/null | head -1`);
      const anyApkPath = findAnyApkCmd.stdout.trim();

      if (await verifyApk(anyApkPath)) {
        const integrity = await ssh.execCommand(`unzip -tq ${sh(anyApkPath)} >/dev/null 2>&1`);
        if (integrity.code !== 0) return { success: false, error: 'APK dibuat tetapi file tidak lolos pemeriksaan integrity.' };
        return { success: true, apkPath: anyApkPath };
      }

      // Last fallback: any APK file
      const findAllApkCmd = await ssh.execCommand(`find ${projectPath} -name "*.apk" -type f 2>/dev/null | head -1`);
      const anyFoundApk = findAllApkCmd.stdout.trim();

      if (await verifyApk(anyFoundApk)) {
        return { success: true, apkPath: anyFoundApk };
      }

      // Never report success unless the expected APK really exists and is non-empty.
      const expectedCheck = await ssh.execCommand(`test -s ${sh(expectedApkPath)} && stat -c%s ${sh(expectedApkPath)} || echo NOT_FOUND`);
      if (expectedCheck.stdout.trim() === 'NOT_FOUND') {
        return {
          success: false,
          error: `Gradle selesai tanpa menghasilkan ${apkFileName}. Periksa output Gradle.`
        };
      }

      const apkSize = parseInt(expectedCheck.stdout.trim(), 10);
      if (!Number.isFinite(apkSize) || apkSize <= 0) {
        return { success: false, error: `APK ${apkFileName} kosong atau tidak valid.` };
      }

      const integrity = await ssh.execCommand(`unzip -tq ${sh(expectedApkPath)} >/dev/null 2>&1`);
      if (integrity.code !== 0) return { success: false, error: 'APK dibuat tetapi file tidak lolos pemeriksaan integrity.' };
      console.log(`[${job.jobId}] APK verified at expected path: ${expectedApkPath} (${apkSize} bytes)`);
      return {
        success: true,
        apkPath: expectedApkPath
      };
    } catch (error) {
      if (error instanceof CancelledError || (job.jobId && jobRegistry.isCancelled(job.jobId))) {
        throw error instanceof CancelledError ? error : new CancelledError();
      }
      console.error(`[${job.jobId}] Build error:`, error.message);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new AndroidPipeline();

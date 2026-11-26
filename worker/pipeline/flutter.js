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

// Detect build failures caused by outdated pub packages being incompatible
// with the Dart/Flutter SDK installed on the worker (e.g. a package extends
// a class that became `final`, or uses a type as a const-map key that no
// longer has a usable `==`). We deliberately do NOT require an exact wording
// match: any compile-time Dart error whose file path points into
// .pub-cache/hosted (a third-party package, not the user's own lib/ code) is
// treated as a candidate for "upgrade the dependency and retry", because the
// project cannot be fixed by touching user code — only by changing the
// package version. This generalizes across any project/template/package,
// since it reasons about *where* the error came from rather than guessing
// every possible error message in advance.
function isPackageCompatibilityError(output) {
  const text = String(output || '');
  // A Dart analyzer/compiler error always looks like: <path>:<line>:<col>: Error: ...
  // Match any such line whose path is inside the pub cache (i.e. dependency
  // source, not the project's own lib/ or test/ directories).
  const pubCacheErrorLine = /(?:^|\n)[^\n:]*\.pub-cache[\\/][^\n:]*\.dart:\d+:\d+:\s*(?:Error|Warning):/i;
  if (pubCacheErrorLine.test(text)) return true;

  // Some failures surface as a generic Gradle/Dart2js task failure without a
  // clean per-line path (e.g. "Target kernel_snapshot_program failed") but
  // still mention pub-cache somewhere alongside a compiler-style Error line.
  const genericPatterns = [
    /can't be (?:extended|implemented|mixed in) outside of its library/i,
    /because it's a (?:final|sealed|base) class/i,
    /does not have a primitive operator/i,
    /const evaluation error/i,
    /couldn't infer type/i,
    /is not a subtype of/i,
    /no longer (?:exported|available|supported)/i
  ];
  const mentionsPubCache = /\.pub-cache[\\/]/i.test(text);
  return mentionsPubCache && genericPatterns.some((re) => re.test(text));
}

// True when the compile error site is inside the PROJECT's own lib/ (or
// test/) source, meaning a package's public API shape no longer matches what
// the user's code expects (e.g. a class stopped being a subtype of Flutter's
// IconData after a major package upgrade). This is fundamentally different
// from a pure SDK/package-internal incompatibility: the fix would require
// editing the user's own widget code (which we must not silently rewrite),
// not just picking a different package version. So this must NEVER trigger a
// further --major-versions upgrade retry, because a bigger major bump only
// risks making the user's code even more broken. It's most useful right
// after we ourselves ran a major-version upgrade, to know we should roll
// that change back instead of trying to "fix" it further.
function isUserCodeApiMismatchError(output) {
  const text = String(output || '');
  // Compiler error whose path is a project source file (lib/ or test/), not
  // .pub-cache, complaining about an argument/type not matching.
  const projectSourceError = /(?:^|\n)(?:lib|test)\/[^\n:]*\.dart:\d+:\d+:\s*Error:/i;
  if (!projectSourceError.test(text)) return false;
  const typeMismatchPatterns = [
    /can't be assigned to the parameter type/i,
    /isn't a subtype of/i,
    /the (?:method|getter|setter) '[^']*' isn't defined/i,
    /too (?:many|few) positional arguments/i
  ];
  return typeMismatchPatterns.some((re) => re.test(text));
}

// When the user's own code fails to compile against a package's current API
// (isUserCodeApiMismatchError), the most likely cause is that pub resolved a
// newer major version of that package than the code was written for (a loose
// "^x.y.z" constraint let `pub get` jump to a breaking release). We can't
// safely rewrite the user's widget code, but we CAN identify which package(s)
// are named in the error (Dart error messages cite the package path, e.g.
// ".../font_awesome_flutter-11.0.0/...") and pin each one back down to the
// latest release of the immediately preceding major version, then retry. This
// generalizes to any package name without hardcoding one.
function extractOffendingPackages(output) {
  const text = String(output || '');
  const re = /\.pub-cache[\\/]hosted[\\/][^\\/\n]+[\\/]([a-zA-Z0-9_]+)-(\d+)\.(\d+)\.(\d+)/g;
  const found = new Map();
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, name, major] = m;
    found.set(name, Number(major));
  }
  return found; // Map<packageName, currentMajorVersion>
}

// Pin each offending package to "<major-1>.<anything>" (e.g. major 11 -> a
// constraint of "<11.0.0", which pub resolves to the newest 10.x.x release)
// directly in pubspec.yaml, so the user's existing code — written against
// that older major version — keeps compiling. Only rewrites simple
// "  package: ^x.y.z" / "  package: x.y.z" lines for the named packages.
async function pinPackagesBelowMajor(ssh, projectPath, offendingPackages) {
  if (!offendingPackages || offendingPackages.size === 0) return { changed: false };
  const assignments = [...offendingPackages.entries()]
    .filter(([, major]) => Number.isFinite(major) && major > 0)
    .map(([name, major]) => `${name}=<${major}.0.0`);
  if (assignments.length === 0) return { changed: false };

  const script = `
set -e
cd ${sh(projectPath)}
FILE="pubspec.yaml"
if [ ! -f "$FILE" ]; then
  echo "PUBSPEC_NOT_FOUND"
  exit 0
fi
CHANGED=0
${assignments.map((a) => {
  const [name, constraint] = a.split('=');
  return `if grep -Eq "^  ${name}: *[\\^0-9]" "$FILE"; then
  sed -i -E "s/^(  ${name}: *).*/\\1\\"${constraint}\\"/" "$FILE"
  CHANGED=1
  echo "PINNED:${name}->${constraint}"
fi`;
}).join('\n')}
if [ "$CHANGED" = "1" ]; then
  echo "CHANGED"
else
  echo "NO_CHANGE"
fi
`;
  const result = await ssh.execCommand(bashScriptCommand(script.trim()));
  const out = (result.stdout || '').trim();
  console.log(`[PubspecPin] ${projectPath}: ${out || result.stderr || '(no output)'}`);
  return { changed: out.includes('CHANGED') && !out.includes('NO_CHANGE'), raw: out };
}



// Pin only explicitly selected packages to the newest version below a major.
// Used after a dependency upgrade when a single package introduces a breaking API
// while other upgraded packages were required to fix SDK compatibility.
async function pinSpecificPackagesBelowMajor(ssh, projectPath, packageMajors) {
  const entries = Object.entries(packageMajors || {}).filter(([, major]) => Number.isFinite(Number(major)) && Number(major) > 0);
  if (!entries.length) return { changed: false };
  const assignments = entries.map(([name, major]) => `${name}=<${Number(major)}.0.0`);
  const script = `
set -e
cd ${sh(projectPath)}
FILE=pubspec.yaml
[ -f "$FILE" ] || { echo PUBSPEC_NOT_FOUND; exit 0; }
CHANGED=0
${assignments.map(a => { const [name, constraint] = a.split('='); return `if grep -Eq "^  ${name}:" "$FILE"; then
  sed -i -E "s|^(  ${name}: *).*|\\1\\"${constraint}\\"|" "$FILE"
  echo "PINNED:${name}->${constraint}"
  CHANGED=1
fi`; }).join('\n')}
[ "$CHANGED" = 1 ] && echo CHANGED || echo NO_CHANGE
`;
  const result = await ssh.execCommand(bashScriptCommand(script.trim()));
  const out = String(result.stdout || '').trim();
  console.log(`[TargetedMajorPin] ${projectPath}: ${out || result.stderr || '(no output)'}`);
  return { changed: out.includes('CHANGED') && !out.includes('NO_CHANGE'), raw: out };
}

function hasFontAwesomeCompatibilityError(output) {
  const text = String(output || '');
  // Do not require the compiler to print a .pub-cache package path. Dart often
  // reports only the project-side type error, so the old path-dependent check
  // could silently miss the exact FaIconData failure we are trying to fix.
  return /FaIconData/.test(text) ||
    (/IconData/.test(text) && /font_awesome_flutter/i.test(text)) ||
    (/IconData' can\'t be extended outside of its library because it\'s a final class/i.test(text));
}

async function projectUsesFontAwesome(ssh, projectPath) {
  const script = String.raw`
set -e
cd ${sh(projectPath)}
if [ ! -d lib ]; then echo NO; exit 0; fi
if grep -RIlE 'FontAwesomeIcons|FaIconData|(^|[^A-Za-z0-9_])FaIcon[[:space:]]*\(' lib --include='*.dart' >/dev/null 2>&1; then
  echo YES
else
  echo NO
fi
`;
  const result = await ssh.execCommand(bashScriptCommand(script.trim()));
  return String(result.stdout || '').trim() === 'YES';
}

async function removeFontAwesomeDependency(ssh, projectPath) {
  const script = String.raw`
set -e
cd ${sh(projectPath)}
FILE=pubspec.yaml
[ -f "$FILE" ] || { echo PUBSPEC_NOT_FOUND; exit 0; }
cp "$FILE" "$FILE.web2apk-fontawesome-backup" 2>/dev/null || true
node - <<'NODE'
const fs = require('fs');
const f = 'pubspec.yaml';
const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
const out = [];
let skipping = false;
let baseIndent = 0;
let changed = false;
for (const line of lines) {
  const m = line.match(/^(\s*)font_awesome_flutter\s*:/);
  if (m) {
    skipping = true;
    baseIndent = m[1].length;
    changed = true;
    continue;
  }
  if (skipping) {
    if (!line.trim()) { continue; }
    const indent = (line.match(/^\s*/) || [''])[0].length;
    // A continuation/map belonging to the dependency stays more indented.
    if (indent > baseIndent) continue;
    skipping = false;
  }
  out.push(line);
}
if (changed) {
  fs.writeFileSync(f, out.join('\n'));
  console.log('REMOVED_FONT_AWESOME_DEPENDENCY');
} else {
  console.log('NO_FONT_AWESOME_DEPENDENCY_CHANGE');
}
NODE
`;
  const result = await ssh.execCommand(bashScriptCommand(script.trim()));
  const out = String(result.stdout || result.stderr || '');
  console.warn(`[FontAwesomeDependency] ${out.trim() || '(no output)'}`);
  return { changed: /REMOVED_FONT_AWESOME_DEPENDENCY/.test(out), raw: out };
}

// Deterministic FontAwesome normalizer. It converts direct FontAwesome widget/type
// usage to Flutter Material icons across the whole lib tree while keeping widget
// structure intact. This deliberately avoids the v10/v11 IconData hierarchy cycle.
async function applyFontAwesomeV11CompatibilityPatch(ssh, projectPath, output = '') {
  // This fixer intentionally does not depend on a particular compiler wording.
  // It is also used pre-build when the uploaded project still contains direct
  // FontAwesome references, which prevents the v10 -> v11 -> FaIconData cycle.
  const mapping = {
    telegram: 'send', whatsapp: 'chat', tiktok: 'play_circle_fill', instagram: 'photo_camera',
    user: 'person', userAstronaut: 'person', circleUser: 'account_circle', userPlus: 'person_add',
    userEdit: 'edit', userSlash: 'person_off', users: 'group', lock: 'lock', unlock: 'lock_open',
    calendarDay: 'calendar_today', calendarPlus: 'event_available', clock: 'schedule',
    house: 'home', home: 'home', box: 'inventory_2', package: 'inventory_2',
    check: 'check_circle', checkCircle: 'check_circle', globe: 'public',
    gear: 'settings', cog: 'settings', bars: 'menu', arrowLeft: 'arrow_back', arrowRight: 'arrow_forward',
    trash: 'delete', trashCan: 'delete', pen: 'edit', pencil: 'edit', download: 'download', upload: 'upload',
    copy: 'content_copy', link: 'link', bell: 'notifications', info: 'info', warning: 'warning',
    triangleExclamation: 'warning', circleExclamation: 'error_outline', xmark: 'close', plus: 'add', minus: 'remove'
  };
  const payload = Buffer.from(JSON.stringify(mapping), 'utf8').toString('base64');
  const script = String.raw`
set -e
cd ${sh(projectPath)}
[ -d lib ] || { echo NO_LIB_DIRECTORY; exit 0; }
MAPPING_B64=${sh(payload)}
MAPPING_B64="$MAPPING_B64" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const mapping = JSON.parse(Buffer.from(process.env.MAPPING_B64, 'base64').toString('utf8'));
function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (ent.isFile() && full.endsWith('.dart')) out.push(full);
  }
  return out;
}

// Single detector used BOTH to decide "does this file still need work" AND
// to verify "is this file actually clean now" — previously these two checks
// used two subtly different regexes (the replacement pass excluded a
// preceding '.', the verification pass did not), which meant a file whose
// FaIcon/FontAwesomeIcons usage happened to be preceded by a character the
// replacement pass treated as "this must be an alias/member access, skip
// it" could get permanently stuck: never rewritten, yet still flagged as
// remaining forever. Using the exact same detector function for both
// decisions eliminates that class of bug by construction.
function stillHasFontAwesome(s) {
  return /FontAwesomeIcons\s*\.\s*[A-Za-z0-9_]+/.test(s)
    || /\bFaIconData\b/.test(s)
    || /\bFaIcon\s*\(/.test(s);
}

function rewriteOnce(s) {
  let changedThisPass = false;
  const before = s;

  // Pass 1: aliased imports (import '...' as fa;) — rewrite fa.FaIcon,
  // fa.FaIconData, fa.FontAwesomeIcons.xxx wherever the alias appears,
  // regardless of what precedes the alias itself (start of line, inside an
  // expression, after a comma, etc. — the alias name is the anchor, not
  // whatever comes before it).
  const aliases = new Set();
  for (const m of s.matchAll(/import\s+['"]package:font_awesome_flutter\/font_awesome_flutter\.dart['"](?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?\s*;/g)) {
    if (m[1]) aliases.add(m[1]);
  }
  for (const alias of aliases) {
    const esc = alias.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp('\\b' + esc + '\\.FaIcon\\s*\\(', 'g'), 'Icon(');
    s = s.replace(new RegExp('\\b' + esc + '\\.FaIconData\\?', 'g'), 'IconData?');
    s = s.replace(new RegExp('\\b' + esc + '\\.FaIconData\\b', 'g'), 'IconData');
    s = s.replace(new RegExp('\\b' + esc + '\\.FontAwesomeIcons\\.([A-Za-z0-9_]+)', 'g'), (_, name) => 'Icons.' + (mapping[name] || 'help_outline'));
  }

  // Pass 2: unqualified / any remaining qualified usage. Rather than trying
  // to guess from context whether a given "FaIcon(" is a bare reference or
  // some other object's member (the previous version's approach, via a
  // negative lookbehind excluding '.'), we simply match FaIcon/FaIconData/
  // FontAwesomeIcons.* ANYWHERE they appear as whole identifiers now — any
  // qualifier before them (someObject.FaIcon(...) is not valid Dart for a
  // top-level class reference like this in the first place; the only
  // legitimate qualified form is the alias case already handled in Pass 1
  // above) is left untouched by \b word-boundary matching on the identifier
  // itself, so this cannot double-rewrite something Pass 1 already fixed.
  s = s.replace(/\bFaIcon\s*\(/g, 'Icon(');
  s = s.replace(/\bFaIconData\?/g, 'IconData?');
  s = s.replace(/\bFaIconData\b/g, 'IconData');
  s = s.replace(/\bFontAwesomeIcons\.([A-Za-z0-9_]+)/g, (_, name) => 'Icons.' + (mapping[name] || 'help_outline'));

  if (s !== before) changedThisPass = true;
  return { s, changedThisPass };
}

let changed = 0, remaining = 0;
const remainingFiles = [];
for (const file of walk('lib')) {
  let s = fs.readFileSync(file, 'utf8');
  const original = s;

  // Apply repeatedly until stable (max 5 passes as a safety bound — in
  // practice this always converges in 1-2 passes, since each pass only
  // shrinks the set of remaining FontAwesome references). This matters for
  // files with alias usage AND unqualified usage mixed together, or
  // overlapping matches that only fully resolve after a prior replacement
  // changed the surrounding text.
  for (let pass = 0; pass < 5; pass++) {
    const { s: next, changedThisPass } = rewriteOnce(s);
    s = next;
    if (!changedThisPass) break;
  }

  // Material Icons require material.dart. Add it only when this conversion
  // actually introduced Icons.* and the file did not already import Material.
  if (/\bIcons\./.test(s) && !/package:flutter\/material\.dart/.test(s)) {
    s = "import 'package:flutter/material.dart';\n" + s;
  }
  // Remove the font_awesome_flutter import only after every known
  // FontAwesome symbol has actually gone (checked with the SAME detector
  // used for the final remaining-count below).
  if (!stillHasFontAwesome(s)) {
    s = s.replace(/^\s*import\s+['"]package:font_awesome_flutter\/font_awesome_flutter\.dart['"](?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?\s*;\s*\r?\n/gm, '');
  }

  if (s !== original) {
    const backup = file + '.web2apk-icon-backup';
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
    fs.writeFileSync(file, s);
    console.log('PATCHED:' + file);
    changed++;
  }

  if (stillHasFontAwesome(s)) {
    remaining++;
    remainingFiles.push(file);
  }
}
console.log('PATCHED_COUNT:' + changed);
console.log('REMAINING_FONT_AWESOME_FILES:' + remaining);
if (remainingFiles.length) {
  console.log('REMAINING_FILES_LIST:' + remainingFiles.join(','));
}
console.log(remaining === 0 ? 'NORMALIZED' : 'PARTIAL_CHANGE');
NODE
`;
  const result = await ssh.execCommand(bashScriptCommand(script.trim()));
  const raw = String(result.stdout || result.stderr || '');
  console.warn(`[FontAwesomeCompat] ${raw.trim() || '(no output)'}`);
  const patchedCount = Number((raw.match(/PATCHED_COUNT:(\d+)/) || [])[1] || 0);
  const remainingCount = Number((raw.match(/REMAINING_FONT_AWESOME_FILES:(\d+)/) || [])[1] || 0);
  const remainingFilesList = (raw.match(/REMAINING_FILES_LIST:(.+)/) || [])[1] || '';
  return {
    changed: /NORMALIZED/.test(raw) && !/PARTIAL_CHANGE/.test(raw),
    patchedCount,
    remainingCount,
    remainingFilesList,
    raw,
  };
}

// Last-resort generic fix: rewrite caret constraints in pubspec.yaml
// (e.g. "^10.9.1" -> "any", "5.0.0") so pub's resolver is free to pick the
// newest release of each dependency instead of being capped by whatever
// version the project happened to be created with. Only touches the
// `dependencies:`/`dev_dependencies:` sections; leaves environment/sdk
// constraints and non-version keys untouched. Returns whether anything
// actually changed, so callers can avoid a pointless retry.
async function loosenPubspecConstraints(ssh, projectPath) {
  const script = `
set -e
cd ${sh(projectPath)}
FILE="pubspec.yaml"
if [ ! -f "$FILE" ]; then
  echo "PUBSPEC_NOT_FOUND"
  exit 0
fi
cp -f "$FILE" "$FILE.web2apk.bak"

# Replace caret constraints ("^x.y.z") with "any" only on simple
# "  package_name: ^x.y.z" lines (2-space indented, inside dependencies
# blocks). This intentionally avoids touching "flutter:", "sdk:", git/path
# dependency maps, or the environment: block.
awk '
  /^dependencies:$/ { in_deps=1 }
  /^dev_dependencies:$/ { in_deps=1 }
  /^environment:$/ { in_deps=0 }
  /^flutter:$/ { in_deps=0 }
  /^[a-zA-Z_]/ && !/^dependencies:$/ && !/^dev_dependencies:$/ { if (!/^[[:space:]]/) in_deps=0 }
  {
    if (in_deps && match($0, /^  [A-Za-z0-9_]+: *\\^[0-9][A-Za-z0-9.+_-]*$/)) {
      sub(/\\^[0-9][A-Za-z0-9.+_-]*$/, "any")
      changed=1
    }
    print
  }
  END { if (changed) print "CHANGED_MARKER" > "/dev/stderr" }
' "$FILE" > "$FILE.tmp" 2> /tmp/awk_marker.$$

if grep -q CHANGED_MARKER /tmp/awk_marker.$$ 2>/dev/null; then
  mv "$FILE.tmp" "$FILE"
  rm -f "$FILE.web2apk.bak" /tmp/awk_marker.$$
  echo "LOOSENED"
else
  rm -f "$FILE.tmp" "$FILE.web2apk.bak" /tmp/awk_marker.$$
  echo "NO_CHANGE"
fi
`;
  const result = await ssh.execCommand(bashScriptCommand(script.trim()));
  const out = (result.stdout || '').trim();
  console.log(`[PubspecLoosen] ${projectPath}: ${out || result.stderr || '(no output)'}`);
  return { changed: out.includes('LOOSENED'), raw: out };
}


// Targeted fallback for package-internal SDK incompatibilities. Unlike a global
// "everything = any" rewrite, this only relaxes the direct dependencies that
// actually appeared in the compiler error. It also removes the lock file and
// package_config so pub is forced to resolve fresh versions instead of reusing
// the exact incompatible versions from a previous build.
async function relaxOffendingPackageConstraints(ssh, projectPath, offendingPackages) {
  if (!offendingPackages || offendingPackages.size === 0) return { changed: false };
  const names = [...offendingPackages.keys()].filter(Boolean);
  if (names.length === 0) return { changed: false };

  const script = `
set -e
cd ${sh(projectPath)}
FILE="pubspec.yaml"
if [ ! -f "$FILE" ]; then
  echo "PUBSPEC_NOT_FOUND"
  exit 0
fi
CHANGED=0
${names.map((name) => `
if grep -Eq "^  ${name}:" "$FILE"; then
  # Only rewrite the simple direct dependency line. Package configuration
  # blocks use different indentation and are intentionally left untouched.
  sed -i -E "s|^(  ${name}:).*|\\1 any|" "$FILE"
  echo "RELAXED:${name}"
  CHANGED=1
fi`).join('\n')}
rm -f pubspec.lock .dart_tool/package_config.json .dart_tool/package_graph.json
if [ "$CHANGED" = "1" ]; then echo "CHANGED"; else echo "NO_CHANGE"; fi
`;
  const result = await ssh.execCommand(bashScriptCommand(script.trim()));
  const out = String(result.stdout || '').trim();
  console.log(`[PubspecTargetedRelax] ${projectPath}: ${out || result.stderr || '(no output)'}`);
  return { changed: out.split(/\r?\n/).includes('CHANGED'), raw: out };
}

// Some old Flutter templates pin the Dart SDK with a stale upper bound. The
// worker can safely retry without that upper bound when the *dependency source*
// itself is known to be incompatible with the installed SDK. We preserve the
// lower bound and only remove an upper bound such as <3.0.0 / <4.0.0.
async function relaxDartSdkUpperBound(ssh, projectPath) {
  const script = `
set -e
cd ${sh(projectPath)}
FILE="pubspec.yaml"
[ -f "$FILE" ] || { echo "PUBSPEC_NOT_FOUND"; exit 0; }
cp -f "$FILE" "$FILE.sdk.bak"
# Handles: sdk: '>=2.17.0 <3.0.0' and sdk: ">=3.0.0 <4.0.0"
python3 - "$FILE" <<'PYCODE'
import re, sys
p=sys.argv[1]
s=open(p, encoding='utf-8').read()
pat=r"(^[ \t]*sdk:[ \t]*['\"]?)(>=\s*[0-9][^\s'\"]*)\s+<\s*[0-9][^\s'\"]*(['\"]?[ \t]*(?:#.*)?$)"
ns,n=re.subn(pat, r"\\1\\2\\3", s, flags=re.M)
open(p,'w',encoding='utf-8').write(ns)
print('CHANGED' if n else 'NO_CHANGE')
PYCODE
`;
  // Avoid relying on process substitution/output plumbing from the embedded
  // script: inspect the resulting pubspec directly after the Python rewrite.
  const result = await ssh.execCommand(bashScriptCommand(script.trim()));
  const after = await ssh.execCommand(`cat ${sh(`${projectPath}/pubspec.yaml`)} 2>/dev/null || true`);
  const before = await ssh.execCommand(`cat ${sh(`${projectPath}/pubspec.yaml.sdk.bak`)} 2>/dev/null || true`);
  const changed = result.code === 0 && String(after.stdout || '') !== String(before.stdout || '');
  console.log(`[PubspecSdkRelax] ${projectPath}: ${changed ? 'CHANGED' : 'NO_CHANGE'}`);
  return { changed };
}

// Snapshot pubspec.yaml/pubspec.lock content before attempting a risky
// dependency upgrade, so it can be restored if the upgrade ends up breaking
// the user's own code (see isUserCodeApiMismatchError). Reads over SSH and
// keeps the content in memory (rather than a remote .bak file) so it survives
// even if later steps delete/replace files unexpectedly.
async function snapshotPubspecFiles(ssh, projectPath) {
  const files = ['pubspec.yaml', 'pubspec.lock'];
  const snapshot = {};
  for (const f of files) {
    const r = await ssh.execCommand(`cat ${sh(`${projectPath}/${f}`)} 2>/dev/null || true`);
    snapshot[f] = r.code === 0 ? r.stdout : null;
  }
  return snapshot;
}

async function restorePubspecFiles(ssh, projectPath, snapshot) {
  for (const [f, content] of Object.entries(snapshot || {})) {
    if (content == null) continue;
    const encoded = Buffer.from(content, 'utf8').toString('base64');
    await ssh.execCommand(
      `bash -lc "printf %s ${encoded} | base64 -d > ${sh(`${projectPath}/${f}`)}"`
    );
  }
}

// jobId is accepted here (rather than only checked at the top level in
// vpsWorker.js) because this single helper is the funnel EVERY shell
// command in the whole auto-fix/retry chain passes through — 18 separate
// call sites across this file, including deep inside multi-step recovery
// branches (dependency upgrade -> retry, icon patch -> retry, pin package
// -> retry, and so on). Checking here once, rather than after every one of
// those 18 call sites individually, guarantees a cancellation request is
// honored the moment control returns here, regardless of which retry
// branch happened to be executing when the user pressed cancel — and can't
// be missed by a future edit that adds call site #19 without remembering
// to add its own check too.
async function runFlutterWithEnv(ssh, projectPath, flutterCmd, commandBody, jobId) {
  if (jobId && jobRegistry.isCancelled(jobId)) {
    throw new CancelledError();
  }
  const script = `
set -e
export BOT=true
export CI=true
export CONTINUOUS_INTEGRATION=true
export FLUTTER_ALLOW_SUPERUSER=1
# Use the same Flutter artifact mirror configured by /installvps.
# This prevents build-time downloads from falling back to a VPS-blocked endpoint.
export FLUTTER_STORAGE_BASE_URL="\${FLUTTER_STORAGE_BASE_URL:-https://storage.flutter-io.cn}"

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
fi

export PATH="$PATH:/opt/flutter/bin:/root/flutter/bin"
FLUTTER_BIN=${sh(flutterCmd)}

if [ -n "$ANDROID_HOME" ]; then
  "$FLUTTER_BIN" config --android-sdk "$ANDROID_HOME" >/dev/null 2>&1 || true
mkdir -p android
fi

# Set sdk.dir/flutter.sdk without destroying existing project properties.
FLUTTER_SDK_PATH=$(dirname "$(dirname "$FLUTTER_BIN")")
mkdir -p android
touch android/local.properties
grep -v -E '^(sdk.dir|flutter.sdk)=' android/local.properties > android/local.properties.tmp || true
{
  cat android/local.properties.tmp
  [ -n "$ANDROID_HOME" ] && echo "sdk.dir=$ANDROID_HOME"
  [ -d "$FLUTTER_SDK_PATH/bin" ] && echo "flutter.sdk=$FLUTTER_SDK_PATH"
} > android/local.properties
rm -f android/local.properties.tmp

# Update only our Gradle properties; do not overwrite project-specific values.
touch android/gradle.properties
set_gradle_prop() {
  key="$1"; value="$2"; file=android/gradle.properties
  if grep -q -E "^\${key}=" "$file"; then
    sed -i "s|^\${key}=.*|\${key}=\${value}|" "$file"
  else
    echo "\${key}=\${value}" >> "$file"
  fi
}
set_gradle_prop org.gradle.daemon false
set_gradle_prop org.gradle.jvmargs '-Xmx4g -XX:MaxMetaspaceSize=512m'
set_gradle_prop android.useAndroidX true
set_gradle_prop android.enableJetifier true

${commandBody}
  `.trim();

  // Race the actual command against a periodic cancellation poll. This is
  // the final safety net: even if requestCancel()'s remote pkill sweep (see
  // jobRegistry.js) somehow fails to actually terminate every process tied
  // to this build — a daemon it didn't anticipate, a zombie subprocess, a
  // wedged SSH channel that never signals close even though the remote
  // process is gone — this ensures runFlutterWithEnv itself still returns
  // control to the caller promptly once isCancelled(jobId) flips true,
  // rather than leaving the entire pipeline (and therefore the worker's
  // "building" status in pool.js) hung indefinitely on a single
  // ssh.execCommand() that may never resolve on its own. We still let the
  // real ssh.execCommand() keep running in the background (its result is
  // simply ignored if the cancellation poll wins the race) since there is
  // no reliable way to abort an in-flight SSH exec channel from the client
  // side without closing the whole connection, which would break any other
  // commands sharing it.
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
      // Also stop polling once the real command finishes on its own, so
      // this interval can't outlive a normal (non-cancelled) command.
      execPromise.finally(() => clearInterval(pollInterval)).catch(() => {});
    }),
  ]);

  if (result && result.__cancelledWhileWaiting) {
    throw new CancelledError();
  }

  // A command that was killed mid-flight by requestCancel()'s pkill (see
  // jobRegistry.js) surfaces here as an ordinary non-zero exit code —
  // indistinguishable from a real build failure UNLESS we also re-check the
  // cancellation flag right after the command returns. Doing so ensures a
  // kill that lands WHILE this specific command was executing is caught
  // immediately, on top of the pre-flight check above that catches a
  // cancellation requested BEFORE this command started.
  if (jobRegistry.isCancelled(jobId)) {
    throw new CancelledError();
  }

  return result;
}

// Bump this whenever the auto-fix retry logic below changes. Printed at the
// start of every build so it's trivial to confirm from server console logs
// whether a deployed copy of this file actually contains the latest fix
// (grep worker output for "AUTOFIX_VERSION" to check).
const AUTOFIX_VERSION = 'flutter-pipeline-autofix-v10-root-fontawesome-normalization';

class FlutterPipeline {
  async run(ssh, worker, job, onProgress = () => {}) {
    const buildDir = worker.buildDir || config.workers.defaultBuildDir;
    const projectPath = job.projectPath || `${buildDir}/${job.jobId}`;
    const flutterCmd = job.flutterCmd || 'flutter';
    console.log(`[${job.jobId}] ${AUTOFIX_VERSION} active.`);

    try {
      await onProgress(20, 'Checking Gradle/AGP/Kotlin compatibility...');
      console.log(`[${job.jobId}] Step 0: Checking Gradle/AGP/Kotlin compatibility...`);
      await ensureGradleCompatibility(ssh, projectPath);

      await onProgress(22, 'Preparing project...');
      console.log(`[${job.jobId}] Step 1: Cleaning...`);

      const clean = await runFlutterWithEnv(
        ssh,
        projectPath,
        flutterCmd,
        '"$FLUTTER_BIN" clean',
        job.jobId
      );
      if (clean.code !== 0) throw new Error(formatCommandError('Flutter clean', clean));

      // Root-level FontAwesome normalization: do this BEFORE pub get/build whenever
      // the uploaded source still uses FontAwesome. This avoids depending on the
      // compiler to expose the same error format and permanently removes the
      // v10 (final IconData) -> v11 (FaIconData mismatch) retry cycle.
      const usesFontAwesome = await projectUsesFontAwesome(ssh, projectPath);
      if (usesFontAwesome) {
        console.warn(`[${job.jobId}] FontAwesome usage found in source; normalizing to stable Material icons before dependency resolution...`);
        await onProgress(28, 'Normalizing incompatible icon APIs...');
        const normalized = await applyFontAwesomeV11CompatibilityPatch(ssh, projectPath);
        if (!normalized.changed) {
          // Partial normalization is NOT treated as fatal anymore. If the
          // vast majority of files were successfully patched (the common
          // case — one file with an unusual usage pattern the normalizer's
          // regex doesn't yet recognize, out of a dozen that patched fine),
          // aborting the entire build over that one file wastes the work
          // already done and gives the user a confusing error instead of a
          // working APK. The one remaining file's compiler error (if it
          // actually turns out to matter) will surface naturally during the
          // build step below, where the existing FontAwesome-error retry
          // path (hasFontAwesomeCompatibilityError, further down this
          // file) already knows how to react to it — so we don't lose
          // error handling, we just stop pre-emptively killing builds that
          // had a real chance of succeeding.
          console.warn(`[${job.jobId}] FontAwesome normalization patched ${normalized.patchedCount} file(s) but ${normalized.remainingCount} file(s) still reference FontAwesome APIs${normalized.remainingFilesList ? `: ${normalized.remainingFilesList}` : ''}. Continuing build — if these residual references actually break compilation, the build step's own FontAwesome-compatibility retry will catch and fix it.`);
        }
        // Only drop the font_awesome_flutter dependency from pubspec.yaml
        // when EVERY file was actually cleaned. If even one file still
        // calls FaIcon/FontAwesomeIcons.*, removing the dependency here
        // would immediately break compilation for that file (undefined
        // symbol), turning a "1 file with unusual formatting" problem into
        // a guaranteed hard failure. Leaving the dependency in place keeps
        // that residual file compiling exactly as it did before — the
        // worst case is simply "no improvement for that one file", not "a
        // new failure we introduced".
        if (normalized.changed) {
          await removeFontAwesomeDependency(ssh, projectPath);
          await ssh.execCommand(`rm -f ${sh(`${projectPath}/pubspec.lock`)} ${sh(`${projectPath}/.dart_tool/package_config.json`)} ${sh(`${projectPath}/.dart_tool/package_graph.json`)}`);
        } else {
          // Even without removing the dependency, stale lockfiles from
          // before the partial patch can still cause a resolution mismatch
          // — clear those so pub get starts clean regardless.
          await ssh.execCommand(`rm -f ${sh(`${projectPath}/pubspec.lock`)} ${sh(`${projectPath}/.dart_tool/package_config.json`)} ${sh(`${projectPath}/.dart_tool/package_graph.json`)}`);
        }
      }

      await onProgress(30, 'Getting dependencies...');
      console.log(`[${job.jobId}] Step 2: Pub get...`);
      const pubGet = await runFlutterWithEnv(
        ssh,
        projectPath,
        flutterCmd,
        '"$FLUTTER_BIN" pub get',
        job.jobId
      );
      if (pubGet.code !== 0) throw new Error(formatCommandError('Flutter pub get', pubGet));

      await onProgress(35, 'Checking launcher icon config...');
      console.log(`[${job.jobId}] Step 2.5: Checking flutter_launcher_icons config...`);
      // Check if flutter_launcher_icons is configured in pubspec.yaml
      const checkConfig = await ssh.execCommand(`test -f pubspec.yaml && grep -q "flutter_launcher_icons:" pubspec.yaml && echo "FOUND" || echo "NOT_FOUND"`, { cwd: projectPath });
      
      if (checkConfig.stdout.trim() === 'FOUND') {
        await onProgress(40, 'Generating launcher icons...');
        console.log(`[${job.jobId}] Step 3: Generating launcher icons...`);
        const genIcons = await runFlutterWithEnv(
          ssh,
          projectPath,
          flutterCmd,
          '"$FLUTTER_BIN" pub run flutter_launcher_icons',
          job.jobId
        );
        if (genIcons.code !== 0) {
          console.warn(`[${job.jobId}] Icon generation warning: ${genIcons.stderr || genIcons.stdout}`);
          // Don't fail build, just log warning
        } else {
          console.log(`[${job.jobId}] Icons generated successfully`);
        }
      } else {
        console.log(`[${job.jobId}] No flutter_launcher_icons config found, skipping`);
      }

      await onProgress(45, 'Validating resources...');
      console.log(`[${job.jobId}] Step 2.5: Checking for corrupt/duplicate icons...`);
      // Check and fix corrupt launcher icons (conservative approach)
      const checkIcons = await runFlutterWithEnv(
        ssh,
        projectPath,
        flutterCmd,
        `
# Remove obviously corrupt (zero-size) icon files
if [ -d "android/app/src/main/res" ]; then
  find android/app/src/main/res/mipmap-* -name "ic_launcher*.png" -size 0 -delete 2>/dev/null || true
  find android/app/src/main/res/mipmap-* -name "ic_launcher*.jpg" -size 0 -delete 2>/dev/null || true
fi

# Remove duplicate icon files (keep PNG, remove JPG if both exist)
if [ -d "android/app/src/main/res" ]; then
  for mipmap in android/app/src/main/res/mipmap-*; do
    if [ -d "$mipmap" ]; then
      for icon in "$mipmap"/ic_launcher*.jpg; do
        if [ -f "$icon" ]; then
          basename=$(basename "$icon" .jpg)
          if [ -f "$mipmap/$basename.png" ]; then
            echo "Removing duplicate JPG: $icon (PNG exists)"
            rm -f "$icon"
          fi
        fi
      done
    fi
  done
  echo "Icon validation complete - removed zero-size and duplicate files"
fi
        `.trim(),
        job.jobId
      );
      // Don't fail on icon check, just log warning
      if (checkIcons.code !== 0) {
        console.warn(`[${job.jobId}] Icon check warning: ${checkIcons.stderr || checkIcons.stdout}`);
      }

      await onProgress(90, 'Building APK...');
      console.log(`[${job.jobId}] Step 3: Building APK (${job.buildType || 'release'})...`);
      
      const isDebug = job.buildType === 'debug';
      // gradle.properties already has org.gradle.daemon=false
      const buildCommand = isDebug
        ? '"$FLUTTER_BIN" build apk --debug --android-skip-build-dependency-validation'
        : '"$FLUTTER_BIN" build apk --release --android-skip-build-dependency-validation';
      
      let buildApk = await runFlutterWithEnv(
        ssh,
        projectPath,
        flutterCmd,
        buildCommand,
        job.jobId
      );

      if (buildApk.code !== 0) {
        const failureOutput = [buildApk.stdout, buildApk.stderr].filter(Boolean).join('\n');
        let initialUserCodeMismatch = isUserCodeApiMismatchError(failureOutput);
        let initialPackageError = isPackageCompatibilityError(failureOutput);

        // IMPORTANT: handle FontAwesome before any broad pub upgrade. This project
        // family can start on v10 (which breaks on new Flutter because IconData is
        // final) and upgrading then lands on v11 (FaIconData is no longer IconData).
        // Remove that cycle deterministically: rewrite all project references to
        // Flutter Material icons, remove the direct package dependency, pub get,
        // then retry. This runs before the generic dependency fixer.
        if (hasFontAwesomeCompatibilityError(failureOutput)) {
          console.warn(`[${job.jobId}] Detected FontAwesome compatibility cycle; normalizing icons before dependency upgrades...`);
          await onProgress(91, 'Replacing incompatible FontAwesome icons...');
          const faPatch = await applyFontAwesomeV11CompatibilityPatch(ssh, projectPath, failureOutput);
          if (faPatch.changed) {
            await removeFontAwesomeDependency(ssh, projectPath);
            await ssh.execCommand(`rm -f ${sh(`${projectPath}/pubspec.lock`)}`);
            const pubGetAfterPatch = await runFlutterWithEnv(ssh, projectPath, flutterCmd, '"$FLUTTER_BIN" pub get', job.jobId);
            if (pubGetAfterPatch.code === 0) {
              await onProgress(92, 'Rebuilding after icon compatibility fix...');
              buildApk = await runFlutterWithEnv(ssh, projectPath, flutterCmd, buildCommand, job.jobId);
            }
          }
          const postPatchOutput = [buildApk.stdout, buildApk.stderr].filter(Boolean).join('\n');
          initialUserCodeMismatch = isUserCodeApiMismatchError(postPatchOutput);
          initialPackageError = isPackageCompatibilityError(postPatchOutput);
        }

        if (buildApk.code !== 0 && (initialPackageError || initialUserCodeMismatch)) {
          // Outdated pub packages are incompatible with the worker's Dart/Flutter
          // SDK. This is generic across projects (different templates/bases will
          // pin different, potentially outdated, package versions).
          //
          // IMPORTANT (simplified from an earlier, slower design): `pub upgrade
          // --major-versions` already resolves each dependency to the newest
          // version compatible with the *currently installed* Dart/Flutter SDK
          // (pub's resolver reads every candidate version's own `environment:
          // sdk:` constraint) — see https://dart.dev/tools/pub/pubspec. So a
          // single major-version upgrade attempt already IS the strongest safe
          // fix; a preceding "plain pub upgrade" step is close to always a
          // guaranteed no-op when the failure is a pure SDK-compat error, and
          // running a full `flutter build apk` (often 3-10 minutes) just to
          // confirm that no-op wastes exactly the time budget the retry chain
          // needs. So: do the major upgrade first, once, and only fall back
          // to more surgical fixes (pin/loosen) if that alone wasn't enough.
          console.warn(`[${job.jobId}] Detected package/SDK compatibility error. Attempting safe auto-fix...`);
          await onProgress(91, 'Dependency incompatible, attempting safe auto-fix...');

          const snapshot = await snapshotPubspecFiles(ssh, projectPath);
          let fixApplied = false;

          // If a package's own source is incompatible with the installed SDK,
          // upgrading is mandatory even when the same log also contains a user-code
          // API mismatch. The previous v4 logic treated any mixed failure as
          // "downgrade everything", which kept google_fonts 4.x broken forever.
          if (initialPackageError) {
            console.warn(`[${job.jobId}] Package source incompatibility detected; upgrading dependencies before compatibility patching...`);
            await onProgress(91, 'Updating incompatible Flutter packages...');
            const pubUpgradeMajor = await runFlutterWithEnv(
              ssh, projectPath, flutterCmd, '"$FLUTTER_BIN" pub upgrade --major-versions', job.jobId
            );
            fixApplied = pubUpgradeMajor.code === 0;
          } else if (initialUserCodeMismatch) {
            const offending = extractOffendingPackages(failureOutput);
            if (offending.size > 0) {
              console.warn(`[${job.jobId}] Project code vs package API mismatch (${[...offending.keys()].join(', ')}). Pinning to previous major version...`);
              await onProgress(91, 'Pinning incompatible packages to a matching version...');
              const pin = await pinPackagesBelowMajor(ssh, projectPath, offending);
              if (pin.changed) {
                const pubGetPinned = await runFlutterWithEnv(ssh, projectPath, flutterCmd, '"$FLUTTER_BIN" pub get', job.jobId);
                fixApplied = pubGetPinned.code === 0;
                if (!fixApplied) await restorePubspecFiles(ssh, projectPath, snapshot);
              }
            }
          }

          if (fixApplied) {
            console.log(`[${job.jobId}] Retrying build after dependency auto-fix...`);
            await onProgress(92, 'Rebuilding APK with fixed packages...');
            buildApk = await runFlutterWithEnv(ssh, projectPath, flutterCmd, buildCommand, job.jobId);
          }

          // If FontAwesome v11 changed its icon type hierarchy, prefer a deterministic
          // source-level compatibility rewrite to stable Material icons. This avoids
          // repeatedly bouncing between an old FontAwesome version (SDK-incompatible)
          // and v11 (FaIconData type-incompatible).
          if (buildApk.code !== 0) {
            const faOutput = [buildApk.stdout, buildApk.stderr].filter(Boolean).join('\n');
            const faPatch = await applyFontAwesomeV11CompatibilityPatch(ssh, projectPath, faOutput);
            if (faPatch.changed) {
              await onProgress(93, 'Replacing incompatible FontAwesome types with stable Flutter icons...');
              buildApk = await runFlutterWithEnv(ssh, projectPath, flutterCmd, buildCommand, job.jobId);
            }
          }


          // Safety net: if whatever we just did broke the user's own code
          // (e.g. the major upgrade introduced a real breaking API change),
          // that is worse than the original, honest failure — roll pubspec
          // back to the pre-fix snapshot and report the original error
          // instead of a self-inflicted one.
          if (buildApk.code !== 0) {
            const afterFix = [buildApk.stdout, buildApk.stderr].filter(Boolean).join('\n');
            if (isUserCodeApiMismatchError(afterFix) && !initialUserCodeMismatch && !initialPackageError) {
              console.warn(`[${job.jobId}] Auto-fix broke the app's own code (API mismatch). Rolling back...`);
              await restorePubspecFiles(ssh, projectPath, snapshot);
              await runFlutterWithEnv(ssh, projectPath, flutterCmd, '"$FLUTTER_BIN" pub get', job.jobId);
              buildApk = await runFlutterWithEnv(ssh, projectPath, flutterCmd, buildCommand, job.jobId);
            }
          }

          // Strong targeted fallback: if pub upgrade did not move the exact
          // packages named by the compiler, force only those direct dependency
          // constraints to resolve again, clear the lock/package config, and
          // retry. This catches projects whose old SDK upper bounds or stale
          // lockfiles prevented --major-versions from selecting compatible code.
          if (buildApk.code !== 0) {
            const stillFailing = [buildApk.stdout, buildApk.stderr].filter(Boolean).join('\n');
            if (isPackageCompatibilityError(stillFailing) && !isUserCodeApiMismatchError(stillFailing)) {
              const offending = extractOffendingPackages(stillFailing);
              console.warn(`[${job.jobId}] Package incompatibility persists. Targeted re-resolution for: ${[...offending.keys()].join(', ') || 'unknown packages'}`);
              await onProgress(92, 'Resolving incompatible packages with fresh versions...');

              let targeted = await relaxOffendingPackageConstraints(ssh, projectPath, offending);
              if (!targeted.changed) {
                // If the offending package is transitive, relaxing direct lines
                // won't change pubspec. Remove only the stale resolution state
                // and try the resolver again before touching broader settings.
                await ssh.execCommand(`rm -f ${sh(`${projectPath}/pubspec.lock`)} ${sh(`${projectPath}/.dart_tool/package_config.json`)} ${sh(`${projectPath}/.dart_tool/package_graph.json`)}`);
                targeted = { changed: true };
              }

              if (targeted.changed) {
                let pubGetTargeted = await runFlutterWithEnv(ssh, projectPath, flutterCmd, '"$FLUTTER_BIN" pub get', job.jobId);
                if (pubGetTargeted.code !== 0) {
                  // A stale Dart SDK upper bound is a common reason the latest
                  // compatible package cannot be selected. Relax it only here,
                  // after a confirmed dependency-source compile failure.
                  const sdkRelax = await relaxDartSdkUpperBound(ssh, projectPath);
                  if (sdkRelax.changed) {
                    pubGetTargeted = await runFlutterWithEnv(ssh, projectPath, flutterCmd, '"$FLUTTER_BIN" pub get', job.jobId);
                  }
                }
                if (pubGetTargeted.code === 0) {
                  await onProgress(93, 'Rebuilding APK after dependency resolution...');
                  buildApk = await runFlutterWithEnv(ssh, projectPath, flutterCmd, buildCommand, job.jobId);
                }
              }
            }
          }

          // Last resort: pubspec.yaml's own upper-bound constraints (e.g.
          // "^10.9.1") may still be preventing the resolver from picking a
          // newer, compatible release (this can happen with transitive
          // dependency conflicts that `--major-versions` alone can't
          // resolve). Loosen constraints so the resolver is free to choose,
          // then retry pub get + build once more. Skip if the failure is a
          // user-code API mismatch, since loosening further only risks
          // pulling in an even less compatible major version.
          if (buildApk.code !== 0) {
            const stillFailing = [buildApk.stdout, buildApk.stderr].filter(Boolean).join('\n');
            if (isPackageCompatibilityError(stillFailing) && !isUserCodeApiMismatchError(stillFailing)) {
              console.warn(`[${job.jobId}] Still failing after upgrade attempt. Loosening pubspec.yaml constraints and retrying...`);
              await onProgress(93, 'Loosening dependency constraints, retrying...');

              const loosen = await loosenPubspecConstraints(ssh, projectPath);
              if (loosen.changed) {
                const pubGetRetry = await runFlutterWithEnv(ssh, projectPath, flutterCmd, '"$FLUTTER_BIN" pub get', job.jobId);
                if (pubGetRetry.code === 0) {
                  console.log(`[${job.jobId}] Retrying build after loosening pubspec constraints...`);
                  await onProgress(94, 'Rebuilding APK with relaxed dependency versions...');
                  buildApk = await runFlutterWithEnv(ssh, projectPath, flutterCmd, buildCommand, job.jobId);

                  if (buildApk.code !== 0) {
                    const afterLoosen = [buildApk.stdout, buildApk.stderr].filter(Boolean).join('\n');
                    if (isUserCodeApiMismatchError(afterLoosen)) {
                      console.warn(`[${job.jobId}] Loosened constraints broke the app's own code. Rolling back...`);
                      await restorePubspecFiles(ssh, projectPath, snapshot);
                      await runFlutterWithEnv(ssh, projectPath, flutterCmd, '"$FLUTTER_BIN" pub get', job.jobId);
                      buildApk = await runFlutterWithEnv(ssh, projectPath, flutterCmd, buildCommand, job.jobId);
                    }
                  }
                } else {
                  console.warn(`[${job.jobId}] pub get after loosening constraints failed, keeping previous build error.`);
                }
              } else {
                console.warn(`[${job.jobId}] No pubspec.yaml constraints could be loosened further.`);
              }
            }
          }
        }

        // Release-only compatibility fallback: a few older apps reference
        // Material/Cupertino icons dynamically. If release tree-shaking is the
        // only failure, retry once without icon tree-shaking. Source and UI are
        // left untouched; the trade-off is a somewhat larger APK.
        if (buildApk.code !== 0 && !isDebug) {
          const lastOutput = [buildApk.stdout, buildApk.stderr].filter(Boolean).join('\n');
          if (/icon tree shaking|tree.?shake.*icon|materialicons|cupertinoicons/i.test(lastOutput)) {
            console.warn(`[${job.jobId}] Icon tree-shaking compatibility issue detected; retrying without icon tree-shaking.`);
            await onProgress(94, 'Fixing release icon compatibility...');
            buildApk = await runFlutterWithEnv(
              ssh, projectPath, flutterCmd,
              '"$FLUTTER_BIN" build apk --release --android-skip-build-dependency-validation --no-tree-shake-icons',
              job.jobId
            );
          }
        }

        if (buildApk.code !== 0) throw new Error(formatCommandError('Flutter build apk', buildApk));
      }

      await onProgress(95, 'Finalizing APK...');

      const apkFileName = isDebug ? 'app-debug.apk' : 'app-release.apk';
      const expectedApkPath = `${projectPath}/build/app/outputs/flutter-apk/${apkFileName}`;

      // Try to find the actual APK file - handle different project structures
      const findApkCmd = await ssh.execCommand(`find ${projectPath} -name "${apkFileName}" -type f 2>/dev/null | head -1`);
      const actualApkPath = findApkCmd.stdout.trim();

      if (actualApkPath) {
        console.log(`[${job.jobId}] APK found at: ${actualApkPath}`);
        const integrity = await ssh.execCommand(`unzip -tq ${sh(actualApkPath)} >/dev/null 2>&1`);
        if (integrity.code !== 0) {
          return { success: false, error: 'APK berhasil dibuat tetapi file APK tidak lolos pemeriksaan ZIP/integrity.' };
        }
        return {
          success: true,
          apkPath: actualApkPath
        };
      }

      // Never report success unless the APK actually exists and is non-empty.
      const expectedCheck = await ssh.execCommand(`test -s ${sh(expectedApkPath)} && stat -c%s ${sh(expectedApkPath)} || echo NOT_FOUND`);
      if (expectedCheck.stdout.trim() === 'NOT_FOUND') {
        return {
          success: false,
          error: `Flutter build selesai tanpa menghasilkan ${apkFileName}. Periksa output Gradle/Flutter.`
        };
      }

      const apkSize = parseInt(expectedCheck.stdout.trim(), 10);
      if (!Number.isFinite(apkSize) || apkSize <= 0) {
        return { success: false, error: `APK ${apkFileName} kosong atau tidak valid.` };
      }

      const integrity = await ssh.execCommand(`unzip -tq ${sh(expectedApkPath)} >/dev/null 2>&1`);
      if (integrity.code !== 0) {
        return { success: false, error: 'APK berhasil dibuat tetapi file APK tidak lolos pemeriksaan ZIP/integrity.' };
      }
      console.log(`[${job.jobId}] APK verified at expected path: ${expectedApkPath} (${apkSize} bytes)`);
      return {
        success: true,
        apkPath: expectedApkPath
      };
    } catch (error) {
      // A cancellation must propagate as a thrown exception, not get folded
      // into the normal { success: false } return shape below — vpsWorker.js
      // specifically checks `error instanceof CancelledError` in its own
      // catch block to distinguish "user cancelled" from "build genuinely
      // failed" (different final message to the user, no error-log file
      // sent, no retry). If we swallowed it here like every other error,
      // the caller would just see a generic failed build and — worse — this
      // function would already have returned normally, meaning any retry
      // wrapper further up the call chain has no signal telling it to stop
      // rather than attempt another build cycle.
      if (error instanceof CancelledError || (job.jobId && jobRegistry.isCancelled(job.jobId))) {
        throw error instanceof CancelledError ? error : new CancelledError();
      }
      console.error(`[${job.jobId}] Build error:`, error.message);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new FlutterPipeline();

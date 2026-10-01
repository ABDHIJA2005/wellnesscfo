const fs = require('node:fs');
const path = require('node:path');

const cmakePath = path.join(
  __dirname,
  '..',
  'node_modules',
  'expo-modules-core',
  'android',
  'CMakeLists.txt',
);

if (!fs.existsSync(cmakePath)) {
  process.exit(0);
}

const source = fs.readFileSync(cmakePath, 'utf8');
const runtimeLink = 'target_link_libraries(${PACKAGE_NAME} c++_shared)';

if (source.includes(runtimeLink)) {
  process.exit(0);
}

const libraryTarget = /add_library\(([\s\S]*?\n\s*\)\n)/;
if (!libraryTarget.test(source)) {
  console.warn('Could not locate expo-modules-core CMake library target; skipping Windows linker patch.');
  process.exit(0);
}

const patched = source.replace(
  libraryTarget,
  `$1\n# Keep libc++ explicitly linked for the Windows NDK toolchain.\n${runtimeLink}\n`,
);
fs.writeFileSync(cmakePath, patched);

const fs = require('fs');
const path = require('path');

const START_DIR = process.cwd();

function getAllTsFiles(dir) {
  let tsFiles = [];
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    // Skip directories starting with "." or named "node_modules"
    if (stat.isDirectory()) {
      const baseName = path.basename(fullPath);
      if (baseName.startsWith('.') || baseName === 'node_modules') {
        continue;
      }
      tsFiles = tsFiles.concat(getAllTsFiles(fullPath));
    } else if (file.endsWith('.ts')) {
      tsFiles.push(fullPath);
    }
  }
  return tsFiles;
}

function countLines(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  // Only count non-empty lines
  return content.split('\n').filter(line => line.trim().length > 0).length;
}

function getDirRelative(filePath) {
  const rel = path.relative(START_DIR, filePath);
  const parts = rel.split(path.sep);
  if (parts.length > 1) {
    return parts[0];
  }
  return '.';
}

function main() {
  const tsFiles = getAllTsFiles(START_DIR);

  const dirLineCounts = {};

  for (const file of tsFiles) {
    const dir = getDirRelative(file);
    const lines = countLines(file);
    dirLineCounts[dir] = (dirLineCounts[dir] || 0) + lines;
  }

  // Print table
  console.log('Directory\tTypeScript Lines');
  console.log('---------\t----------------');
  Object.entries(dirLineCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([dir, lines]) => {
      console.log(`${dir}\t\t${lines}`);
    });
}

main();
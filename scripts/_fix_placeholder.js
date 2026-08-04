const fs = require('fs');
const file = 'd:/Work Projects/Harness/server/index.ts';
let content = fs.readFileSync(file, 'utf8');
const lines = content.split('\n');
let line = lines[2065];

// Replace placeholder text
line = line.replace(/e\.g\. deepseek-chat/g, 'e.g. deepseek-v4-pro');

const count = (line.match(/deepseek-v4-pro/g) || []).length;
console.log(`Replaced ${count} occurrences`);
console.log('Old "deepseek-chat" remaining:', (line.match(/placeholder="e\.g\. deepseek-chat/g) || []).length);

lines[2065] = line;
fs.writeFileSync(file, lines.join('\n'), 'utf8');

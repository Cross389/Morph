const fs = require('fs');
const p = process.argv[2];
const s = fs.readFileSync(p).toString('utf8');
console.log('size', s.length);
console.log('has 构建助手 :', s.includes('构建助手'));
console.log('has id=panel :', s.includes('id="panel"'));
console.log('has tbVersions:', s.includes('tbVersions'));
console.log('has tbSave    :', s.includes('tbSave'));
console.log('has versionsModal:', s.includes('versionsModal'));

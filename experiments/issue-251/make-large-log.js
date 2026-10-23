// Writes a finite synthetic log: ordinary lines, one 15 MB escaped-JSON line,
// a token longer than a 64 KB block and invalid UTF-8 bytes.
const fs = require('fs');
const [target, megabytes = '20'] = process.argv.slice(2);
const out = fs.openSync(target, 'w');
const line = (text) => fs.writeSync(out, `${text}\n`);
line("Command: gate='/tmp/hive-mind-disk-baseline-0ce9e170-e6d3-494d-91e1-0d820245d34b'");
line('🧠 Formal AI: endpoint http://172.18.0.2:8080/api/openai/v1');
const prompt = 'use: curl -L -H \\"Authorization: token $(gh auth token)\\" -o <filename> <url>\\n';
line(`{"bodyPreview":"{\\"messages\\":[{\\"content\\":\\"${prompt.repeat(Math.floor((15 * 1024 * 1024) / prompt.length))}\\"}]}"}`);
line(`Authorization: Bearer ${'a'.repeat(200 * 1024)} tail`);
fs.writeSync(out, Buffer.from([0x62, 0x61, 0x64, 0x20, 0xff, 0xfe, 0x0a]));
const ordinary = 'INFO ordinary output line with http://127.0.0.1:34271/session and konard@example.com\n';
for (let written = 16 * 1024 * 1024; written < Number(megabytes) * 1024 * 1024; written += ordinary.length * 1000) {
  fs.writeSync(out, ordinary.repeat(1000));
}
line(`token ghp_${'x'.repeat(36)} end`);
fs.closeSync(out);

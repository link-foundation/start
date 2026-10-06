/** Stream Docker output without buffering lines; observe only timestamped output. */
const fs = require('fs');
const { StringDecoder } = require('string_decoder');
const { activityPath } = require('./execution-attempt');

class OutputObserver {
  constructor(logPath, number, since) {
    this.logPath = logPath;
    this.activity = activityPath({ logPath, attempt: { number } });
    this.since = Date.parse(since);
    this.prefix = '';
    this.atLineStart = true;
    this.latest = null;
    this.decoder = new StringDecoder('utf8');
  }

  write(chunk) {
    fs.appendFileSync(this.logPath, chunk);
    let latest = null;
    for (const character of this.decoder.write(chunk)) {
      if (character === '\n') {
        this.atLineStart = true;
        this.prefix = '';
      } else if (this.atLineStart) {
        this.prefix += character;
        if (character === ' ') {
          const text = this.prefix.trim();
          const time = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(
            text
          )
            ? Date.parse(text)
            : NaN;
          if (
            Number.isFinite(time) &&
            time >= this.since &&
            (this.latest === null || time > this.latest)
          ) {
            this.latest = time;
            latest = new Date(time).toISOString();
          }
          this.atLineStart = false;
        } else if (this.prefix.length > 80) {
          this.atLineStart = false;
        }
      }
    }
    if (latest) {
      const temporary = `${this.activity}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, latest);
      fs.renameSync(temporary, this.activity);
    }
  }
}

if (require.main === module) {
  const [logPath, number, since] = process.argv.slice(2);
  const observer = new OutputObserver(logPath, Number(number), since);
  process.stdin.on('data', (chunk) => observer.write(chunk));
}

module.exports = { OutputObserver };

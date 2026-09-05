// An actual interactive process inside the platform PTY; no fake terminal transport.
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let line = '';
process.stdout.write('POCKET_READY\r\n');
process.stdin.on('data', data => {
  for (const char of data) {
    if (char === '\x03') { process.stdout.write('INTERRUPTED\r\n'); continue; }
    if (char !== '\r' && char !== '\n') {
      line += char;
      if (/^\x1b\[\d+;\d+R$/.test(line)) { line = ''; process.stdout.write('QUERY_REPLIED\r\n'); }
      continue;
    }
    const command = line; line = '';
    if (command === 'size') process.stdout.write(`SIZE:${process.stdout.columns}x${process.stdout.rows}\r\n`);
    else if (command === 'cwd') process.stdout.write(`CWD:${process.cwd()}\r\n`);
    else if (command === 'delayed') setTimeout(() => process.stdout.write('OFFLINE_RESULT\r\n'), 250);
    else if (command === 'query-later') setTimeout(() => process.stdout.write('\x1b[6n'), 250);
    else if (command === 'exit') process.exit(0);
    else process.stdout.write(`ECHO:${command}\r\n`);
  }
});

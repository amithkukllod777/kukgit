import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { buildEmailMessage, sendSmtpMessage } from '../src/email-transport.mjs';

async function fakeSmtpServer(t) {
  const messages = [];
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 smtp.test ESMTP ready\r\n');
    let buffer = '';
    let dataMode = false;
    socket.on('data', (chunk) => {
      buffer += chunk;
      while (true) {
        if (dataMode) {
          const marker = buffer.indexOf('\r\n.\r\n');
          if (marker < 0) return;
          messages.push(buffer.slice(0, marker));
          buffer = buffer.slice(marker + 5);
          dataMode = false;
          socket.write('250 2.0.0 queued as test-message\r\n');
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (line.startsWith('EHLO ')) socket.write('250-smtp.test\r\n250 SIZE 5242880\r\n');
        else if (line.startsWith('MAIL FROM:')) socket.write('250 2.1.0 sender accepted\r\n');
        else if (line.startsWith('RCPT TO:')) socket.write('250 2.1.5 recipient accepted\r\n');
        else if (line === 'DATA') {
          dataMode = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (line === 'QUIT') {
          socket.write('221 2.0.0 bye\r\n');
          socket.end();
        } else socket.write('500 5.5.1 unsupported command\r\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, messages };
}

function config(port) {
  return {
    baseUrl: 'http://kukgit.test',
    smtpHost: '127.0.0.1',
    smtpPort: port,
    smtpSecure: false,
    smtpStartTls: false,
    smtpRejectUnauthorized: true,
    smtpUser: '',
    smtpPassword: '',
    emailFrom: 'noreply@kukgit.test',
    emailFromName: 'KukGit Notifications',
    emailReplyTo: 'support@kukgit.test',
  };
}

test('delivers a multipart transactional email through SMTP', async (t) => {
  const smtp = await fakeSmtpServer(t);
  const result = await sendSmtpMessage(config(smtp.port), {
    to: 'developer@example.com',
    subject: 'Pull request approved ✓',
    text: 'Your pull request was approved.\n.Opening-dot line',
    html: '<p>Your pull request was <b>approved</b>.</p>',
  });
  assert.equal(result.accepted, true);
  assert.equal(result.responseCode, 250);
  assert.equal(smtp.messages.length, 1);
  const raw = smtp.messages[0];
  assert.match(raw, /From: "KukGit Notifications" <noreply@kukgit\.test>/);
  assert.match(raw, /To: developer@example\.com/);
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  assert.match(raw, /Content-Type: multipart\/alternative/);
  assert.match(raw, /\.\.Opening-dot line/);
  assert.match(raw, /X-KukGit-Notification: transactional/);
});

test('rejects email header injection and invalid recipients before connecting', () => {
  const base = config(2525);
  assert.throws(
    () => buildEmailMessage(base, { to: 'victim@example.com', subject: 'Safe\r\nBcc: attacker@example.com', text: 'Body' }),
    (error) => error.code === 'EMAIL_HEADER_INJECTION',
  );
  assert.throws(
    () => buildEmailMessage({ ...base, emailFromName: 'KukGit\nBcc: attacker@example.com' }, { to: 'victim@example.com', subject: 'Safe', text: 'Body' }),
    (error) => error.code === 'EMAIL_HEADER_INJECTION',
  );
  assert.throws(
    () => buildEmailMessage(base, { to: 'not-an-email', subject: 'Safe', text: 'Body' }),
  );
});

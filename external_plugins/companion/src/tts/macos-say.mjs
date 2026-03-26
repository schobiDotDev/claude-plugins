import { execFile } from 'node:child_process';

export function speak(text, voice = 'Samantha') {
  return new Promise((resolve) => {
    execFile('say', ['-v', voice, text], (err) => {
      resolve(!err);
    });
  });
}

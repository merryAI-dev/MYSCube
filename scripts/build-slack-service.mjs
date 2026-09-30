import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('slack-dist', { recursive: true });
writeFileSync('slack-dist/robots.txt', 'User-agent: *\nDisallow: /\n');

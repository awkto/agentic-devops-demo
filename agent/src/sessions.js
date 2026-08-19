// Message-array persistence for the provider-agnostic loop. The SDK kept
// sessions under HOME/.claude; here we own them: one JSON file per session id,
// mapped to Mattermost root posts via state.json (see server.js).
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

const file = (id) => path.join(config.sessionsDir, `${id}.json`);

export function load(id) {
  try {
    return JSON.parse(fs.readFileSync(file(id), 'utf8'));
  } catch {
    return null;
  }
}

export function save(id, messages) {
  try {
    fs.mkdirSync(config.sessionsDir, { recursive: true });
    fs.writeFileSync(file(id), JSON.stringify(messages));
  } catch (err) {
    console.error(`session save ${id} failed`, err.message);
  }
}

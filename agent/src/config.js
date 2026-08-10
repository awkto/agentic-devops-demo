const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var ${name}`);
  return v;
};

export const config = {
  port: Number(process.env.PORT || 8080),
  webhookSecret: required('WEBHOOK_SECRET'),
  model: process.env.AGENT_MODEL || 'claude-sonnet-5',
  defaultMode: process.env.AGENT_DEFAULT_MODE || 'read-write',
  idleMinutes: Number(process.env.AGENT_IDLE_MINUTES || 15),
  domain: required('DOMAIN'),
  mattermost: {
    url: required('MM_URL'),
    token: required('MM_BOT_TOKEN'),
    team: process.env.MM_TEAM || 'ops',
    channel: process.env.MM_CHANNEL || 'incidents',
  },
  zammad: {
    url: required('ZAMMAD_URL'),
    token: required('ZAMMAD_TOKEN'),
  },
  wiki: {
    url: required('WIKI_URL'),
  },
  bao: {
    url: required('BAO_URL'),
    token: required('BAO_TOKEN'),
  },
  icinga: {
    url: process.env.ICINGA_API_URL || '',
    user: process.env.ICINGA_API_USER || 'agent',
    password: process.env.ICINGA_API_PASSWORD || '',
  },
};

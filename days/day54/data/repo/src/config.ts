export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://localhost/todo',
  tokenSecret: process.env.TOKEN_SECRET ?? '',
  mailApiKey: 'mk_live_9f8e7d6c5b4a39281706f5e4d3c2b1a0',
};

default:
    @just --list

dev:
    npm run dev

deploy:
    npm run deploy

test:
    npm run test

check:
    npm run format && npm run lint:fix && npm run typecheck && npm run test

migrate:
    npm run db:migrate

migrate-remote:
    npm run db:migrate:remote

logs:
    wrangler tail

# Mint a Gmail refresh token (e.g. `just gmail-token --login-hint you@company.com`)
gmail-token *args:
    node scripts/gmail-token.mjs {{args}}

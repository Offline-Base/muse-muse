# Runs the Muse Muse site on your own machine: a production Next.js build on PGlite (compose.yaml sets it).
# No secrets go in the image. .dockerignore keeps every .env file out of the build, and compose.yaml passes yours at run time.
# Not the way the live site deploys: that is Vercel. See "Quickstart" in README.md for what works here and what needs a key.
FROM node:22-bookworm-slim

ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# Uploads go to .data/files through /api/files. The browser code reads this at build time, so it has to be set here.
ENV NEXT_PUBLIC_LOCAL_FILES=1

WORKDIR /app
RUN chown node:node /app
USER node

# Dev dependencies stay in: PGlite and tsx are dev dependencies, and next start needs typescript to read next.config.ts.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY --chown=node:node . .

# /offline and the longer /private are static pages behind this flag, so it is read at build time, not run time.
ARG STORY_PAGES=""

# next build, not npm run build: migrations need the running container's database, so they run in CMD below.
RUN STORY_PAGES="$STORY_PAGES" npx next build

# Made here so the named volumes in compose.yaml start out owned by the node user.
RUN mkdir -p .data .workflow-data

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Binds every interface inside the container so the port can be published. compose.yaml publishes it on 127.0.0.1 only.
CMD ["sh", "-c", "npx tsx scripts/migrate.ts && exec npx next start -H 0.0.0.0 -p \"$PORT\""]

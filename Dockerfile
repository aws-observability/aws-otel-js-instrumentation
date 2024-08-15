# Comments TODO
FROM node:20 AS build

# Copy Source Code without original package.json (try to keep original package.json in the future)...
WORKDIR /
COPY tsconfig.base.json ./tsconfig.base.json
WORKDIR /operator-build
COPY aws-distro-opentelemetry-node-autoinstrumentation/src ./src/
COPY aws-distro-opentelemetry-node-autoinstrumentation/tsconfig.json ./tsconfig.json
COPY aws-distro-opentelemetry-node-autoinstrumentation/LICENSE ./LICENSE
# ... but also add the required autoinstrumentation.ts and package.json to be consistent with upstream
# https://github.com/open-telemetry/opentelemetry-operator/tree/main/autoinstrumentation/nodejs
COPY docker-utils/autoinstrumentation.ts ./src/autoinstrumentation.ts
COPY docker-utils/package.json ./package.json

RUN npm install

WORKDIR /operator-build/build/workspace
RUN pwd
RUN ls -ls

# TODO - use scratch image
FROM public.ecr.aws/amazonlinux/amazonlinux:minimal

# (TODO) Required to copy attribute files to distributed docker images
#          ADD THIRD-PARTY-LICENSES ./THIRD-PARTY-LICENSES

COPY --from=build /operator-build/build/workspace /autoinstrumentation

RUN chmod -R go+r /autoinstrumentation
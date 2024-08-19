# # Stage 1: Install ADOT nodejs instrumentation in the /operator-build folder
FROM node:20 AS build

# In the future, when ADOT JS is uploaded to NPM, the source code can be obtained from there
# and this Dockerfile will not need to copy the source code anymore as a workaround.
# Copy Source Code without original package.json
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

# Stage 2: Build the cp-utility binary
FROM rust:1.75 as builder

WORKDIR /usr/src/cp-utility
COPY ./tools/cp-utility .

## TARGETARCH is defined by buildx
# https://docs.docker.com/engine/reference/builder/#automatic-platform-args-in-the-global-scope
ARG TARGETARCH

# Run validations and audit only on amd64 because it is faster and those two steps
# are only used to validate the source code and don't require anything that is
# architecture specific.

# Validations
# Validate formatting
RUN if [ $TARGETARCH = "amd64" ]; then rustup component add rustfmt && cargo fmt --check ; fi

# Audit dependencies
RUN if [ $TARGETARCH = "amd64" ]; then cargo install cargo-audit && cargo audit ; fi


# Cross-compile based on the target platform.
RUN if [ $TARGETARCH = "amd64" ]; then export ARCH="x86_64" ; \
    elif [ $TARGETARCH = "arm64" ]; then export ARCH="aarch64" ; \
    else false; \
    fi \
    && rustup target add ${ARCH}-unknown-linux-musl \
    && cargo test  --target ${ARCH}-unknown-linux-musl \
    && cargo install --target ${ARCH}-unknown-linux-musl --path . --root .


# Stage 3: Build the distribution image by copying the THIRD-PARTY-LICENSES, the custom built cp command from stage 2, and the installed ADOT nodejs instrumentation from stage 1 to their respective destinations
FROM scratch

# Required to copy attribute files to distributed docker images
# ADD THIRD-PARTY-LICENSES ./THIRD-PARTY-LICENSES

COPY --from=builder /usr/src/cp-utility/bin/cp-utility /bin/cp
COPY --from=build /operator-build/build/workspace /autoinstrumentation

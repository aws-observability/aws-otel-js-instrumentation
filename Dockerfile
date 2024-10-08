# Stage 1: Install ADOT nodejs instrumentation in the /operator-build folder
FROM public.ecr.aws/docker/library/node:20 AS build

# Build the ADOT JS SDK Tarball: aws-aws-distro-opentelemetry-node-autoinstrumentation-x.y.z.tgz
WORKDIR /adot-js-build
COPY . .
RUN npm install
WORKDIR /adot-js-build/aws-distro-opentelemetry-node-autoinstrumentation
RUN npm run compile
RUN npm pack

# Install Tarball build from previous step so that autoinstrumentation.ts can "require" the ADOT JS SDK
WORKDIR /operator-build
COPY docker-utils/ .
COPY aws-distro-opentelemetry-node-autoinstrumentation/tsconfig.json ./tsconfig.json
RUN cp /adot-js-build/aws-distro-opentelemetry-node-autoinstrumentation/aws-aws-distro-opentelemetry-node-autoinstrumentation-*.tgz ./
RUN npm install aws-aws-distro-opentelemetry-node-autoinstrumentation-$(node -p -e "require('/adot-js-build/aws-distro-opentelemetry-node-autoinstrumentation/package.json').version").tgz
RUN npm install

# Stage 2: Build the cp-utility binary
FROM public.ecr.aws/docker/library/rust:1.75 as builder

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
ADD THIRD-PARTY-LICENSES ./THIRD-PARTY-LICENSES

COPY --from=builder /usr/src/cp-utility/bin/cp-utility /bin/cp
COPY --from=build /operator-build/build/workspace /autoinstrumentation

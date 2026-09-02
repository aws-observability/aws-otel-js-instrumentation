#!/bin/bash
# Post-build verification for the ADOT JS (Node) auto-instrumentation image.
# This script:
#   1. runs the image's own cp-utility to copy /autoinstrumentation into an operator volume,
#   2. confirms the payload actually landed (the copy ran and is non-empty),
#   3. loads the volume payload the way the operator does (node --require the entry script) and
#      asserts the ADOT distro resolves FROM the volume, reports the expected release version,
#      and its `register` entry (the operator's real hook) resolves -- i.e. the RIGHT, working
#      artifact ported, and
#   4. checks the copied tree is byte-for-byte identical to the payload baked into the image
#      (diff -r + aggregate sha256).
#
# Steps 1-2 + 4 are copy fidelity (bytes moved intact); step 3 is the "ported correctly" check
# a pure checksum can't give -- it proves the payload actually loads and self-identifies.
#
# Mirrors the Python image verifier (test-adot-python-image.sh); Tier 1 is identical, Tier 3 is
# the Node equivalent of the Python distro/entry-point load check.
#
# Usage: test-adot-js-image.sh <TEST_TAG> [EXPECTED_VERSION]
#   TEST_TAG         image ref to test (a locally built, not-yet-pushed image)
#   EXPECTED_VERSION optional; when set (release runs pass env.VERSION) the ported package's
#                    version must match exactly. Omit for local runs against source.

set -x -e -u

TEST_TAG=$1
EXPECTED_VERSION="${2:-}"

VOLUME=operator-volume
WORKDIR=$(mktemp -d)
IMAGE_SRC="${WORKDIR}/image-src"
VOLUME_COPY="${WORKDIR}/volume-copy"

# Link the neutral verifier image to the Node the payload was built with: read the Dockerfile's
# build stage (the `... AS build` line) rather than hardcoding, so it can't drift. Fall back to
# node:20 if the parse yields anything other than a concrete node:X image.
DOCKERFILE="${DOCKERFILE:-Dockerfile}"
if [ -z "${NEUTRAL_IMAGE:-}" ]; then
  NEUTRAL_IMAGE=$(grep -iE 'AS[[:space:]]+build[[:space:]]*$' "${DOCKERFILE}" 2>/dev/null | head -1 | awk '{print $2}')
fi
case "${NEUTRAL_IMAGE:-}" in
  *node:[0-9]*) : ;;  # concrete node:X ref -> trust it
  *)
    echo "warning: could not derive a concrete node image from ${DOCKERFILE} (got '${NEUTRAL_IMAGE:-}'); falling back to node:20"
    NEUTRAL_IMAGE="public.ecr.aws/docker/library/node:20"
    ;;
esac

cleanup() {
  docker rm -f adot-verify >/dev/null 2>&1 || true
  docker rm -f adot-src >/dev/null 2>&1 || true
  docker volume rm "${VOLUME}" >/dev/null 2>&1 || true
  rm -rf "${WORKDIR}"
}
trap cleanup EXIT

docker volume create "${VOLUME}"

# 1. Exercise the image's own cp-utility exactly as the operator init container does:
#    recursively copy the baked-in /autoinstrumentation payload into the shared volume.
docker run --rm --mount source="${VOLUME}",dst=/otel-auto-instrumentation "${TEST_TAG}" \
  /bin/cp -r /autoinstrumentation /otel-auto-instrumentation

# 2. Assert the payload actually landed in the operator volume, using a neutral container
#    (the ADOT image is FROM scratch and has no shell/coreutils).
docker run -d --name adot-verify --mount source="${VOLUME}",dst=/otel-auto-instrumentation \
  "${NEUTRAL_IMAGE}" sleep 300 >/dev/null
docker cp adot-verify:/otel-auto-instrumentation "${VOLUME_COPY}"
if [ -z "$(ls -A "${VOLUME_COPY}" 2>/dev/null)" ]; then
  echo "error: /autoinstrumentation was not copied into the operator-volume"
  exit 1
fi
echo "autoinstrumentation payload was copied to the operator-volume"

# 3. VERIFY THE PORTED IMAGE. Preload the payload's entry the way the OTel Operator does
#    (node --require .../autoinstrumentation.js, which pulls in the SDK's /register hook), then
#    assert the distro resolves from the volume, the version matches, and /register resolves.
#    Exporters are disabled so preloading the SDK has no network side effects.
# NOTE: -i is required so the heredoc on stdin is forwarded into the container's `node -`.
docker run --rm -i \
  --mount source="${VOLUME}",dst=/otel-auto-instrumentation \
  -e OTEL_PAYLOAD=/otel-auto-instrumentation \
  -e EXPECTED_VERSION="${EXPECTED_VERSION}" \
  -e NODE_PATH=/otel-auto-instrumentation/node_modules \
  -e OTEL_TRACES_EXPORTER=none \
  -e OTEL_METRICS_EXPORTER=none \
  -e OTEL_LOGS_EXPORTER=none \
  "${NEUTRAL_IMAGE}" node --require /otel-auto-instrumentation/autoinstrumentation.js - <<'JS'
const fs = require('fs');
const payload = process.env.OTEL_PAYLOAD;
const pkg = '@aws/aws-distro-opentelemetry-node-autoinstrumentation';

// (a) the ADOT distro resolves, and does so FROM the operator volume (not some other install).
const resolved = fs.realpathSync(require.resolve(pkg));
if (!resolved.startsWith(fs.realpathSync(payload))) {
  throw new Error(`ADOT distro resolved from ${resolved}, not the operator volume ${payload}`);
}

// (b) the operator's real hook -- the `register` entry -- resolves from the ported payload.
require.resolve(pkg + '/register');

// (c) the ported package reports the expected release version (proves the correctly-versioned
//     source was built into the image).
const pkgJsonPath = `${payload}/node_modules/@aws/aws-distro-opentelemetry-node-autoinstrumentation/package.json`;
const version = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')).version;
const expected = process.env.EXPECTED_VERSION || '';
if (expected && version !== expected) {
  throw new Error(`ported distro version ${version} != expected ${expected}`);
}

// Reaching here also means the --require of autoinstrumentation.js executed without throwing,
// i.e. the operator's exact preload path loads.
console.log(`ported image verified: ${pkg}@${version} loaded from the operator volume; register entry resolved`);
process.exit(0);
JS

# 4. Copy fidelity: the copied tree must be byte-for-byte identical to the image payload.
#    (scratch image: create -- but never start -- a container to copy the original out of.)
docker create --name adot-src "${TEST_TAG}" /bin/cp >/dev/null
docker cp adot-src:/autoinstrumentation "${IMAGE_SRC}"
if diff -r "${IMAGE_SRC}" "${VOLUME_COPY}"; then
  echo "copied autoinstrumentation payload matched the image payload"
else
  echo "error: copied autoinstrumentation payload differs from the image payload"
  exit 1
fi

ORIG_CHECKSUM=$(cd "${IMAGE_SRC}" && find . -type f -exec sha256sum {} \; | LC_ALL=C sort | sha256sum | cut -d' ' -f1)
COPY_CHECKSUM=$(cd "${VOLUME_COPY}" && find . -type f -exec sha256sum {} \; | LC_ALL=C sort | sha256sum | cut -d' ' -f1)
if [ "${COPY_CHECKSUM}" = "${ORIG_CHECKSUM}" ]; then
  echo "copied autoinstrumentation checksum matched (${COPY_CHECKSUM})"
else
  echo "error: copied autoinstrumentation checksum mis-matched (image=${ORIG_CHECKSUM} volume=${COPY_CHECKSUM})"
  exit 1
fi

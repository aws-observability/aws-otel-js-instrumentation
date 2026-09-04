#!/bin/bash
# Post-build verification for the ADOT JS (Node) auto-instrumentation image. Three complementary
# checks, each catching what the others cannot:
#   - Load: the operator-copied payload loads (node --require the entry), the package resolves from
#     the volume, is the expected version, and its `register` hook resolves. Covers runtime + deps;
#     always runs.
#   - Copy fidelity: the only check of the cp-utility -- the volume copy is byte-for-byte identical
#     to the image payload (diff -r).
#   - Independent reference (optional): the image's library matches the separately-built npm
#     tarball (like adot-java). Catches library corruption that still loads. Skipped if the tarball
#     is absent; only a real mismatch fails.
#
# Usage: test-adot-js-image.sh <TEST_TAG> [EXPECTED_VERSION] [TARBALL]
#   TEST_TAG         image ref to test (a locally built, not-yet-pushed image)
#   EXPECTED_VERSION optional; when set (release runs pass env.VERSION) the ported package's
#                    version must match exactly. Omit for local runs against source.
#   TARBALL          optional path to the release npm tarball (.tgz). When set, the image's library
#                    build output is cross-checked against this independently-built artifact.

set -x -e -u

TEST_TAG=$1
EXPECTED_VERSION="${2:-}"
TARBALL="${3:-}"

PKG=@aws/aws-distro-opentelemetry-node-autoinstrumentation

# Per-run unique names so a run killed before the trap fires (cancelled workflow, OOM) can't
# leave a volume/containers behind for the next run to pick up -- which would make diff -r
# compare a mixed tree.
RUN_ID="$$-${RANDOM}"
VOLUME="operator-volume-${RUN_ID}"
VERIFY_CTR="adot-verify-${RUN_ID}"
SRC_CTR="adot-src-${RUN_ID}"
WORKDIR=$(mktemp -d)
IMAGE_SRC="${WORKDIR}/image-src"
VOLUME_COPY="${WORKDIR}/volume-copy"

cleanup() {
  docker rm -f "${VERIFY_CTR}" >/dev/null 2>&1 || true
  docker rm -f "${SRC_CTR}" >/dev/null 2>&1 || true
  docker volume rm "${VOLUME}" >/dev/null 2>&1 || true
  rm -rf "${WORKDIR}"
}
trap cleanup EXIT

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

docker volume create "${VOLUME}"

# Extract the image's baked-in payload up front (scratch image: create, don't run) -- used for
# the copy-fidelity diff and the independent-reference check.
docker create --name "${SRC_CTR}" "${TEST_TAG}" /bin/cp >/dev/null
docker cp "${SRC_CTR}":/autoinstrumentation "${IMAGE_SRC}"

# 1. Exercise the image's own cp-utility exactly as the operator init container does:
#    recursively copy the baked-in /autoinstrumentation payload into the shared volume.
docker run --rm --mount source="${VOLUME}",dst=/otel-auto-instrumentation "${TEST_TAG}" \
  /bin/cp -r /autoinstrumentation /otel-auto-instrumentation

# 2. Assert the payload actually landed in the operator volume, using a neutral container
#    (the ADOT image is FROM scratch and has no shell/coreutils).
docker run -d --name "${VERIFY_CTR}" --mount source="${VOLUME}",dst=/otel-auto-instrumentation \
  "${NEUTRAL_IMAGE}" sleep 300 >/dev/null
docker cp "${VERIFY_CTR}":/otel-auto-instrumentation "${VOLUME_COPY}"
if [ -z "$(ls -A "${VOLUME_COPY}" 2>/dev/null)" ]; then
  echo "error: /autoinstrumentation was not copied into the operator-volume"
  exit 1
fi
echo "autoinstrumentation payload was copied to the operator-volume"

# 3. VERIFY THE PORTED IMAGE. Preload the payload's entry the way the OTel Operator does
#    (node --require .../autoinstrumentation.js, which pulls in the SDK's /register hook), then
#    assert the package resolves from the volume, the version matches, and /register resolves.
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

// (a) the ADOT distro's `register` hook -- the operator's real entry -- resolves, and does so
//     FROM the operator volume. The package exposes no bare main via its "exports" map, so we
//     resolve the /register subpath the operator actually uses rather than the bare package.
const resolved = fs.realpathSync(require.resolve(pkg + '/register'));
if (!resolved.startsWith(fs.realpathSync(payload))) {
  throw new Error(`ADOT distro register hook resolved from ${resolved}, not the operator volume ${payload}`);
}

// (b) the ported package reports the expected release version.
const pkgJsonPath = `${payload}/node_modules/@aws/aws-distro-opentelemetry-node-autoinstrumentation/package.json`;
const version = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')).version;
const expected = process.env.EXPECTED_VERSION || '';
if (expected && version !== expected) {
  throw new Error(`ported distro version ${version} != expected ${expected}`);
}

// Reaching here also means the --require of autoinstrumentation.js executed without throwing.
console.log(`ported image verified: ${pkg}@${version} loaded from the operator volume; register entry resolved`);
process.exit(0);
JS

# 4. Copy fidelity: the copied tree must be byte-for-byte identical to the image payload
#    (already extracted to ${IMAGE_SRC} up front).
if diff -r "${IMAGE_SRC}" "${VOLUME_COPY}"; then
  echo "copied autoinstrumentation payload matched the image payload"
else
  echo "error: copied autoinstrumentation payload differs from the image payload"
  exit 1
fi

# 5. Independent-reference check (optional): diff the image's installed library build output against
#    the separately-built npm tarball (npm pack -> package/build). Best-effort -- warn and SKIP if
#    the tarball is missing/unreadable so reference acquisition never blocks a release; only a real
#    content mismatch fails. Transitive deps have no independent artifact, so are not covered.
if [ -n "${TARBALL}" ]; then
  REF="${WORKDIR}/tar-ref"
  mkdir -p "${REF}"
  PKGDIR="${IMAGE_SRC}/node_modules/${PKG}"
  if [ ! -f "${TARBALL}" ]; then
    echo "warning: tarball reference '${TARBALL}' not found; skipping independent-reference check"
  elif ! tar -xzf "${TARBALL}" -C "${REF}"; then
    echo "warning: could not extract tarball reference '${TARBALL}'; skipping independent-reference check"
  elif diff -r "${REF}/package/build" "${PKGDIR}/build"; then
    echo "image library matched the independently-built tarball"
  else
    echo "error: image library differs from the independently-built tarball"
    exit 1
  fi
fi

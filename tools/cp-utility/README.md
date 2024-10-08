# Introduction

This copy utility is intended to be used as a base image for OpenTelemetry Operator
autoinstrumentation images. The copy utility will allow the ADOT JavaScript build to be
copied from the init container to the final destination volume.

## Development

### Pre-requirements

* Install rust

```shell
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

* Install rustfmt

```shell
rustup component add rustfmt
```

### Development

* Auto formatting the code

This step is important and it might fail the build if the files are not properly
formatted.

```shell
cargo fmt
```

* Testing the code

```shell
cargo test
```

* Building the code

```shell
cargo build
```

NOTE: this will build the code for tests locally. It will not statically link the libc used by it.


* Building the code statically linked

```shell
cargo build --target x86_64-unknown-linux-musl
```


### Docker image

In the root of this project, there is a Dockerfile that is supposed to be used during release.
This Dockerfile can be used with buildx to generate images for the arm64 and x86_64 platforms.

# Contributing Guidelines

Thank you for your interest in contributing to our project. Whether it's a bug report, new feature, correction, or additional
documentation, we greatly value feedback and contributions from our community.

Please read through this document before submitting any issues or pull requests to ensure we have all the necessary
information to effectively respond to your bug report or contribution.


## Reporting Bugs/Feature Requests

We welcome you to use the GitHub issue tracker to report bugs or suggest features.

When filing an issue, please check existing open, or recently closed, issues to make sure somebody else hasn't already
reported the issue. Please try to include as much information as you can. Details like these are incredibly useful:

* A reproducible test case or series of steps
* The version of our code being used
* Any modifications you've made relevant to the bug
* Anything unusual about your environment or deployment


## Contributing via Pull Requests

Contributions via pull requests are much appreciated. Before sending us a pull request, please ensure that:

1. You are working against the latest source on the *main* branch.
2. You check existing open, and recently merged, pull requests to make sure someone else hasn't addressed the problem already.
3. You open an issue to discuss any significant work - we would hate for your time to be wasted.
4. You are not mixing substantial refactoring changes in with functional changes.
   1. If refactoring is desirable, publish a separate refactoring PR first, followed by a functional change PR. This will ensure safe and efficient reviews.
   2. PRs that do not meet these expectations will be rejected.

To send us a pull request, please:

1. Fork the repository.
2. Modify the source; please focus on the specific change you are contributing. If you also reformat all the code, it will be hard for us to focus on your change.
3. Ensure local tests pass.
4. Commit to your fork using clear commit messages.
5. Send us a pull request, answering any default questions in the pull request interface.
6. Pay attention to any automated CI failures reported in the pull request, and stay involved in the conversation.
7. Please do not squash commits between revisions, this makes review challenging, as the diff between revisions is harder to find and review.

GitHub provides additional document on [forking a repository](https://help.github.com/articles/fork-a-repo/) and
[creating a pull request](https://help.github.com/articles/creating-a-pull-request/).

The following sections provide some guidance that will help you make contributions.

## NPM Commands for ADOT JS Development

The following are useful commands that can be run within the `root` directory of this repository.

Use `npm install` within the root directory to initialize all package directories before running any of the following commands.

### Build TypeScript into JavaScript

```shell
npm run compile
```

### Lint

```shell
npm run lint
```

### Lint automatic fixing

```shell
npm run lint:fix
```

### Run unit tests

```shell
npm run test
```

### Test the local ADOT JS package with your own local NodeJS project

In the root directory of `aws-otel-js-instrumentation`, run:

```shell
./scripts/build_and_install_distro.sh
```

In the target local NodeJS project to be instrumented, run

```shell
npm install
npm install /<PATH>/<TO>/aws-distro-opentelemetry-node-autoinstrumentation
```

Your NodeJS project can now be run with your local copy of the ADOT NodeJS code with:

```shell
node --require '@aws/aws-distro-opentelemetry-node-autoinstrumentation/register' your-application.js.js
```


## Finding contributions to work on

Looking at the existing issues is a great way to find something to contribute on. As our projects, by default, use the default GitHub issue labels (enhancement/bug/duplicate/help wanted/invalid/question/wontfix), looking at any 'help wanted' issues is a great place to start.


## Code of Conduct

This project has adopted the [Amazon Open Source Code of Conduct](https://aws.github.io/code-of-conduct).
For more information see the [Code of Conduct FAQ](https://aws.github.io/code-of-conduct-faq) or contact
<opensource-codeofconduct@amazon.com> with any additional questions or comments.


## Security issue notifications

If you discover a potential security issue in this project we ask that you notify AWS/Amazon Security via our [vulnerability reporting page](http://aws.amazon.com/security/vulnerability-reporting/). Please do **not** create a public github issue.


## Licensing

See the [LICENSE](LICENSE) file for our project's licensing. We will ask you to confirm the licensing of your contribution.

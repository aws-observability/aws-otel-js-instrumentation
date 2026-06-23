# Use an official Node.js runtime as the base image
FROM public.ecr.aws/docker/library/node:20-alpine

# Set the working directory inside the container
WORKDIR /lambda-lite-sdk

# Copy the relevant files
COPY ./dist/$DISTRO /lambda-lite-sdk
COPY ./contract-tests/images/applications/lambda-lite-sdk /lambda-lite-sdk

ARG DISTRO
# Install dependencies
RUN npm install
RUN npm install ./${DISTRO}

# Expose the port the app runs on
EXPOSE 8080

# Bootstrap the lite SDK through the distro's register entrypoint. With
# AWS_LAMBDA_LITE_MODE=true (set by the contract test), register.ts routes to
# configureLiteMode() instead of the full NodeSDK.
CMD ["node", "--require", "@aws/aws-distro-opentelemetry-node-autoinstrumentation/register", "server.js"]

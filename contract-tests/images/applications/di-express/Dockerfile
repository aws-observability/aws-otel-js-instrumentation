# Use an official Node.js runtime as the base image
ARG NODE_VERSION=20
FROM node:${NODE_VERSION}-alpine

# Set the working directory inside the container
WORKDIR /di-express

# Copy the relevant files
COPY ./dist/$DISTRO /di-express
COPY ./contract-tests/images/applications/di-express /di-express

ARG DISTRO
# Install dependencies
RUN npm install
RUN npm install ./${DISTRO}

# Expose the port the app runs on
EXPOSE 8080

# Run the app with nodejs auto instrumentation
CMD ["node", "--require", "@aws/aws-distro-opentelemetry-node-autoinstrumentation/register", "app.js"]

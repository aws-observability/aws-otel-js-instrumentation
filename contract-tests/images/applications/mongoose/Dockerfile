# Use an official Node.js runtime as the base image
FROM node:20-alpine
#FROM node:20

# Set the working directory inside the container
WORKDIR /mongoose

# Copy the relevant files
COPY ./dist/$DISTRO /mongoose
COPY ./contract-tests/images/applications/mongoose /mongoose


ARG DISTRO
# Install dependencies
RUN npm install
RUN npm install ./${DISTRO}

# Expose the port the app runs on
EXPOSE 8080

# Run the app with nodejs auto instrumentation
CMD ["node", "--require", "@aws/aws-distro-opentelemetry-node-autoinstrumentation/register", "server.js"]

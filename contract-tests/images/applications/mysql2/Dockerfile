# Use an official Node.js runtime as the base image
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /mysql2

# Copy the relevant files
COPY ./dist/$DISTRO /mysql2
COPY ./contract-tests/images/applications/mysql2 /mysql2


ARG DISTRO
# Install dependencies
RUN npm install
RUN npm install ./${DISTRO}

# Expose the port the app runs on
EXPOSE 8080

# Run the app with nodejs auto instrumentation
CMD ["node", "--require", "@aws/aws-distro-opentelemetry-node-autoinstrumentation/register", "server.js"]

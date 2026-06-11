# Use an official Node.js runtime as the base image
FROM public.ecr.aws/docker/library/node:20-alpine

# Set the working directory inside the container
WORKDIR /serviceevents-fastify

# Copy the relevant files
COPY ./dist/$DISTRO /serviceevents-fastify
COPY ./contract-tests/images/applications/serviceevents-fastify /serviceevents-fastify

ARG DISTRO
# Install dependencies
RUN npm install
RUN npm install ./${DISTRO}

# Expose the port the app runs on
EXPOSE 8080

# Run the app with nodejs auto instrumentation
CMD ["node", "--require", "@aws/aws-distro-opentelemetry-node-autoinstrumentation/register", "app.js"]

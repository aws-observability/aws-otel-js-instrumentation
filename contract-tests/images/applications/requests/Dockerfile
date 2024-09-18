# Meant to be run from aws-otel-python-instrumentation/contract-tests.
# Assumes existence of dist/aws_opentelemetry_distro-<pkg_version>-py3-none-any.whl.
# Assumes filename of aws_opentelemetry_distro-<pkg_version>-py3-none-any.whl is passed in as "DISTRO" arg.
FROM python:3.10
WORKDIR /requests
COPY ./dist/$DISTRO /requests
COPY ./contract-tests/images/applications/requests /requests

ENV PIP_ROOT_USER_ACTION=ignore
ARG DISTRO
RUN pip install --upgrade pip && pip install -r requirements.txt && pip install ${DISTRO} --force-reinstall
RUN opentelemetry-bootstrap -a install

# Without `-u`, logs will be buffered and `wait_for_logs` will never return.
CMD ["opentelemetry-instrument", "python", "-u", "./requests_server.py"]
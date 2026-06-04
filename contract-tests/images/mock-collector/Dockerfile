FROM python:3.10
WORKDIR /mock-collector
COPY . /mock-collector

ENV PIP_ROOT_USER_ACTION=ignore
RUN pip install --upgrade pip && pip install -r requirements.txt

# Expose gRPC (4315) and OTLP/HTTP (4318) receiver ports
EXPOSE 4315 4318

# Without `-u`, logs will be buffered and `wait_for_logs` will never return.
CMD ["python", "-u", "./mock_collector_server.py"]
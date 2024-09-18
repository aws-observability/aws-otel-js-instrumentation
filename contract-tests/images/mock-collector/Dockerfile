FROM python:3.10
WORKDIR /mock-collector
COPY . /mock-collector

ENV PIP_ROOT_USER_ACTION=ignore
RUN pip install --upgrade pip && pip install -r requirements.txt

# Without `-u`, logs will be buffered and `wait_for_logs` will never return.
CMD ["python", "-u", "./mock_collector_server.py"]
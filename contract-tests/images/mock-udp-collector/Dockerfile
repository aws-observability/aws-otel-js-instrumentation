FROM python:3.10
WORKDIR /mock-udp-collector
COPY . /mock-udp-collector

ENV PIP_ROOT_USER_ACTION=ignore
RUN pip install --upgrade pip && pip install -r requirements.txt

EXPOSE 2000/udp
EXPOSE 8080

# Without `-u`, logs will be buffered and `wait_for_logs` will never return.
CMD ["python", "-u", "./mock_udp_collector.py"]

### Overview

MockCollector mimics the behaviour of the actual OTEL collector, but stores export requests to be retrieved by contract tests. 

### Protos
To build protos:
1. Run `pip install grpcio grpcio-tools`
2. Change directory to `aws-otel-python-instrumentation/contract-tests/images/mock-collector/` 
3. Run: `python -m grpc_tools.protoc -I./protos --python_out=. --pyi_out=. --grpc_python_out=. ./protos/mock_collector_service.proto`
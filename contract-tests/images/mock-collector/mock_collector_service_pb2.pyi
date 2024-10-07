from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Optional as _Optional

DESCRIPTOR: _descriptor.FileDescriptor

class ClearRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class ClearResponse(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class GetTracesRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class GetTracesResponse(_message.Message):
    __slots__ = ("traces",)
    TRACES_FIELD_NUMBER: _ClassVar[int]
    traces: _containers.RepeatedScalarFieldContainer[bytes]
    def __init__(self, traces: _Optional[_Iterable[bytes]] = ...) -> None: ...

class GetMetricsRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class GetMetricsResponse(_message.Message):
    __slots__ = ("metrics",)
    METRICS_FIELD_NUMBER: _ClassVar[int]
    metrics: _containers.RepeatedScalarFieldContainer[bytes]
    def __init__(self, metrics: _Optional[_Iterable[bytes]] = ...) -> None: ...

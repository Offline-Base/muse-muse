"""The 0.2.3 wheel's enums (same names and values) and the few models submit.py reads."""

from enum import Enum

from ..types import UNSET


class _StrEnum(str, Enum):
    def __str__(self):
        return str(self.value)


class ArtifactType(_StrEnum):
    TESTLOG = "TestLog"
    TESTPACKAGE = "TestPackage"
    TESTSCRIPT = "TestScript"


class JobType(_StrEnum):
    AUTOMATED = "Automated"
    INTERACTIVE = "Interactive"
    UNDEFINED = "Undefined"


class JobMode(_StrEnum):
    APPLICATION = "Application"
    UNDEFINED = "Undefined"


class TestFramework(_StrEnum):
    APPIUM = "Appium"
    BASH = "Bash"
    MONKEY = "Monkey"
    POWERSHELL = "PowerShell"
    UNDEFINED = "Undefined"


class JobSubmissionParameter(_StrEnum):
    BLUETOOTHENABLED = "BluetoothEnabled"
    GPSENABLED = "GpsEnabled"
    INSTALLSNPE = "InstallSNPE"
    REFLASHENABLEDBEFOREJOBSTART = "ReflashEnabledBeforeJobStart"
    SCREENALWAYSON = "ScreenAlwaysOn"
    SSHONLY = "SshOnly"
    WIFIENABLED = "WifiEnabled"


class JobState(_StrEnum):
    CANCELED = "Canceled"
    COMPLETED = "Completed"
    DISPATCHED = "Dispatched"
    RUNNING = "Running"
    SETUP = "Setup"
    SUBMITTED = "Submitted"
    UNDEFINED = "Undefined"


class JobResult(_StrEnum):
    ABORTED = "Aborted"
    ERROR = "Error"
    PENDING = "Pending"
    SUCCESSFUL = "Successful"
    UNDEFINED = "Undefined"
    UNSUCCESSFUL = "Unsuccessful"


class LogUploadStatus(_StrEnum):
    COMPLETED = "Completed"
    FAILED = "Failed"
    INPROGRESS = "InProgress"
    NOLOGS = "NoLogs"
    UNDEFINED = "Undefined"


class ChipsetCategory(_StrEnum):
    AUTOMOTIVE = "Automotive"
    COMPUTE = "Compute"
    IOT = "IOT"
    MOBILE = "Mobile"
    UNDEFINED = "Undefined"


class OS(_StrEnum):
    ANDROID = "Android"
    LINUX = "Linux"
    QNX = "QNX"
    UBUNTU = "Ubuntu"
    WINDOWS = "Windows"


class TargetState(_StrEnum):
    AVAILABLENOW = "AvailableNow"
    DEVICESBUSY = "DevicesBusy"
    UNAVAILABLE = "Unavailable"
    UNDEFINED = "Undefined"


class _Model:
    def __init__(self, **fields):
        for name in self.FIELDS:
            setattr(self, name, fields.pop(name, UNSET))
        if fields:
            raise TypeError(f"unknown fields {sorted(fields)}")


class TargetType0(_Model):
    FIELDS = (
        "target_id",
        "chipset_name",
        "chipset_marketing_name",
        "chipset_platform_name",
        "chipset_category",
        "os",
        "os_version",
        "state",
    )


class PaginatedTargetsType0(_Model):
    FIELDS = ("page_number", "page_size", "total", "data")


class JobTargetLiteType0(_Model):
    FIELDS = ("chipset_category", "chipset", "chipset_alias", "chipset_marketing_name", "chipset_platform_name")


class JobType0(_Model):
    FIELDS = (
        "job_id",
        "job_name",
        "external_job_id",
        "created_on",
        "completed_on",
        "user_name",
        "org_id",
        "state",
        "result",
        "log_upload_status",
        "targets",
    )


class JobLogsType0(_Model):
    FIELDS = ("filename", "file_size_in_byte")

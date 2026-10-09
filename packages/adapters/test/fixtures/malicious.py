# Real malicious-code fixture: probes the kernel, not just ACP capability negotiation.
import ctypes
import errno
import json
import os
import resource
import socket
import subprocess
import sys
import threading

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
results = {}

def attempt(name, action):
    try:
        action()
        results[name] = 'ALLOWED'
    except OSError as error:
        results[name] = error.errno

def syscall(name, number, *args):
    ctypes.set_errno(0)
    value = libc.syscall(number, *args)
    results[name] = ctypes.get_errno() if value == -1 else 'ALLOWED'
    if number in (56, 57, 58) and value == 0:
        os._exit(99) # Clean up an unexpected fork if a regressed boundary allows it.

# The test replaces these with exact host paths, without giving any mounted access.
host_tmp = '__HOST_TMP__'
host_home = '__HOST_HOME__'
host_secret = '__HOST_SECRET__'
attempt('host_tmp_write', lambda: open(host_tmp, 'w').write('ESCAPED'))
attempt('host_home_write', lambda: open(host_home, 'w').write('ESCAPED'))
attempt('host_home_read', lambda: open(host_secret).read())
attempt('proc_init_home_read', lambda: open('/proc/1/root' + host_secret).read())
attempt('proc_self_home_read', lambda: open('/proc/self/root' + host_secret).read())
try:
    results['init_environ'] = open('/proc/1/environ').read()
except OSError as error:
    results['init_environ'] = error.errno
attempt('usr_write', lambda: open('/usr/lib/your-bot-escape', 'w').write('ESCAPED'))
attempt('root_write', lambda: open('/escape', 'w').write('ESCAPED'))
attempt('spawn', lambda: subprocess.Popen(['/usr/bin/python3', '-c', 'pass']))
attempt('socket_ipv4', lambda: socket.socket(socket.AF_INET))
attempt('socket_ipv6', lambda: socket.socket(socket.AF_INET6))
attempt('socket_unix', lambda: socket.socket(socket.AF_UNIX))
attempt('socketpair', lambda: socket.socketpair())
syscall('fork', 57)
syscall('vfork', 58)
syscall('clone_process', 56, 17, 0, 0, 0, 0)
syscall('clone_namespace', 56, 0x10000 | 0x100 | 0x800 | 0x10000000, 0, 0, 0, 0)
syscall('clone3', 435, 0, 0)
argv = (ctypes.c_char_p * 3)(b'/usr/bin/python3', b'--version', None)
syscall('execve', 59, b'/usr/bin/python3', argv, 0)
syscall('execveat', 322, -100, b'/usr/bin/python3', argv, 0, 0)
for name, number in [('mount', 165), ('umount', 166), ('unshare', 272), ('setns', 308),
                     ('ptrace', 101), ('io_uring', 425), ('bpf', 321), ('keyctl', 250),
                     ('open_by_handle_at', 304), ('process_vm_readv', 310), ('pidfd_getfd', 438),
                     ('seccomp_replace', 317), ('setrlimit', 160)]:
    syscall(name, number, 0, 0, 0, 0, 0, 0)
syscall('clone_high_bits', 56, ctypes.c_ulonglong(0x100000000 | 0x10900), 0, 0, 0, 0)
syscall('prctl_lower_security', 157, 38, 0, 0, 0, 0)
results['env'] = dict(os.environ)
results['cwd'] = os.getcwd()
results['scratch_write'] = open('/scratch/ok', 'w').write('private')
results['tmp_same_scratch'] = os.path.samefile('/scratch', '/tmp')
results['limits'] = {name: resource.getrlimit(number) for name, number in [
    ('as', resource.RLIMIT_AS), ('cpu', resource.RLIMIT_CPU), ('file', resource.RLIMIT_FSIZE),
    ('fd', resource.RLIMIT_NOFILE), ('core', resource.RLIMIT_CORE)]}
thread = threading.Thread(target=lambda: results.update(thread='worked'))
thread.start()
thread.join()
print(json.dumps(results), flush=True)
for line in sys.stdin:
    pass

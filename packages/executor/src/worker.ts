/** Trusted bootstrap. No site/.pth/package code runs before the kernel filter. */
export const PYTHON_WORKER = String.raw`
import sys, os, json, ctypes, resource, math, statistics, csv, io, traceback, time, runpy

def report(value):
    data = ('\n\x1eYOURBOT_RESULT ' + json.dumps(value, allow_nan=False, separators=(',', ':')) + '\n').encode()
    while data:
        data = data[os.write(1, data):]

try:
    config = json.loads(sys.stdin.buffer.read(1048577))
    limits = config['limits']
    for kind, value in [(resource.RLIMIT_AS, limits['memory']),
                        (resource.RLIMIT_FSIZE, limits['file']),
                        (resource.RLIMIT_CPU, limits['cpu']),
                        (resource.RLIMIT_NOFILE, 64),
                        (resource.RLIMIT_CORE, 0)]:
        resource.setrlimit(kind, (value, value))
    os.umask(0o077)
    # AUDIT_ARCH_X86_64; alternate ABI/int80 and x32 calls cannot pass this list.
    if os.uname().machine != 'x86_64':
        raise RuntimeError('Unsupported seccomp architecture')
    class Filter(ctypes.Structure):
        _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte), ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint32)]
    class Program(ctypes.Structure):
        _fields_ = [('len', ctypes.c_ushort), ('filter', ctypes.POINTER(Filter))]
    # Default EPERM. No process/thread creation, exec, sockets, mount, namespace,
    # ptrace, io_uring, BPF, signal sending, or resource-limit modification.
    allowed = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,17,18,19,20,21,
               23,24,25,26,27,28,32,33,35,39,40,60,63,72,73,74,75,76,77,
               78,79,80,81,82,83,84,85,86,87,88,89,90,91,95,96,97,98,99,
               100,102,104,107,108,110,111,115,118,120,121,124,131,132,137,
               138,186,187,191,192,193,194,195,196,201,202,204,217,219,
               228,229,230,231,235,257,258,261,262,263,264,265,266,267,
               268,269,270,271,273,274,280,285,292,295,296,309,316,318,
               326,327,328,332,436,437,439]
    ins = [Filter(0x20,0,0,4), Filter(0x15,1,0,0xc000003e),
           Filter(0x06,0,0,0x80000000), Filter(0x20,0,0,0)]
    # CPython's custom-opener path uses FIOCLEX. Permit only descriptor/TTY
    # queries and CLOEXEC; arbitrary device ioctls remain denied.
    ins.extend([Filter(0x15,0,8,16), Filter(0x20,0,0,24)])
    for request in [0x5401, 0x5450, 0x5451]:
        ins.extend([Filter(0x15,0,1,request), Filter(0x06,0,0,0x7fff0000)])
    ins.append(Filter(0x06,0,0,0x00050001))
    for nr in allowed:
        ins.extend([Filter(0x15,0,1,nr), Filter(0x06,0,0,0x7fff0000)])
    ins.append(Filter(0x06,0,0,0x00050001))
    filters = (Filter * len(ins))(*ins)
    program = Program(len(ins), filters)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0 or libc.prctl(22, 2, ctypes.byref(program), 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'seccomp setup failed')
    report({'ready': True})
except BaseException as exc:
    report({'error': {'code': 'SANDBOX_UNAVAILABLE', 'message': str(exc)}})
    sys.exit(1)

try:
    mode = config['mode']
    if mode == 'install':
        # Only the approved installer wheel is loaded; no installed .pth hooks.
        import zipfile
        total = 0
        for wheel in config['wheels']:
            with zipfile.ZipFile(wheel) as archive:
                entries = archive.infolist()
                if len(entries) > 4096:
                    raise ValueError('Wheel has too many entries')
                for entry in entries:
                    name = entry.filename
                    if name.startswith('/') or chr(92) in name or '..' in name.split('/') or chr(0) in name:
                        raise ValueError('Unsafe wheel member path')
                    total += entry.file_size
                    if entry.file_size > limits['file'] or total > 64 * 1024 * 1024:
                        raise ValueError('Wheel exceeds installation disk limits')
        sys.path.insert(0, config['pipWheel'])
        sys.prefix = sys.exec_prefix = '/venv'
        sys.argv = ['pip', 'install', '--no-index', '--no-deps', '--only-binary=:all:',
                    '--disable-pip-version-check', '--no-cache-dir', '--no-compile',
                    '--prefix', '/venv'] + config['wheels']
        try:
            runpy.run_module('pip', run_name='__main__')
        except SystemExit as exc:
            if exc.code not in (None, 0):
                raise RuntimeError('pip failed with exit ' + str(exc.code))
        result = {'installed': config['packages']}
    else:
        sys.prefix = sys.exec_prefix = '/venv'
        sys.path.append(config['sitePackages'])
        input = config['input']
        files = config['files']
        result = None
        if mode == 'python':
            namespace = {'__name__': '__main__', 'input': input, 'files': files, 'result': None}
            exec(compile(config['code'], '<approved-python>', 'exec'), namespace)
            result = namespace.get('result')
        elif mode == 'skill':
            skill = config['skill']
            if skill == 'calculation':
                values = input['values']
                if not isinstance(values, list) or not values or not all(type(x) in (int, float) and math.isfinite(x) for x in values):
                    raise ValueError('values must be a nonempty array of finite numbers')
                operation = input['operation']
                operations = {'sum': sum, 'product': math.prod, 'mean': statistics.mean,
                              'median': statistics.median, 'min': min, 'max': max,
                              'stdev': statistics.stdev, 'variance': statistics.variance}
                result = operations[operation](values)
            elif skill == 'data.analysis':
                rows = input.get('rows')
                if rows is None:
                    with open(files[input['path']], newline='') as source:
                        rows = list(csv.DictReader(source))
                column = input['column']
                values = [float(row[column]) for row in rows if row.get(column) not in (None, '')]
                if not values or not all(math.isfinite(x) for x in values):
                    raise ValueError('column must contain finite numeric values')
                result = {'count': len(values), 'sum': sum(values), 'min': min(values), 'max': max(values),
                          'mean': statistics.mean(values), 'median': statistics.median(values),
                          'stdev': statistics.stdev(values) if len(values) > 1 else 0}
            elif skill == 'structured.json':
                value = input.get('value')
                if 'text' in input:
                    value = json.loads(input['text'])
                if 'path' in input:
                    with open(files[input['path']]) as source:
                        value = json.load(source)
                for key in input.get('select', []):
                    value = value[key]
                result = value
            elif skill == 'structured.csv':
                text = input.get('text')
                if 'path' in input:
                    with open(files[input['path']], newline='') as source:
                        text = source.read()
                result = list(csv.DictReader(io.StringIO(text)))
            elif skill == 'file.read':
                with open(files[input['path']]) as source:
                    result = source.read()
            elif skill == 'file.write':
                with open(files[input['path']], 'w', encoding='utf-8') as target:
                    target.write(input['text'])
                    result = {'bytes': len(input['text'].encode('utf-8'))}
            else:
                raise ValueError('Unknown skill')
        else:
            raise ValueError('Unknown execution mode')
    report({'value': result})
except BaseException as exc:
    traceback.print_exc(file=sys.stderr)
    report({'error': {'code': 'EXECUTION_FAILED', 'message': str(exc)[:2000]}})
    sys.exit(1)
`;

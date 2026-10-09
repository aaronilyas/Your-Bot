/** Trusted source, compiled locally; never includes harness-supplied C or compiler flags. */
export const LINUX_BOOTSTRAP_SOURCE = String.raw`
#define _GNU_SOURCE
#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <linux/sched.h>

#if !defined(__x86_64__) || defined(__ILP32__)
#error Only Linux x86_64 LP64 is supported
#endif

static struct sock_filter filter[512];
static unsigned count;
static void stmt(unsigned short code, unsigned k) {
  filter[count++] = (struct sock_filter)BPF_STMT(code, k);
}
static void jump(unsigned short code, unsigned k, unsigned char yes, unsigned char no) {
  filter[count++] = (struct sock_filter)BPF_JUMP(code, k, yes, no);
}
static void denied(void) { stmt(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM); }
static void allowed(void) { stmt(BPF_RET | BPF_K, SECCOMP_RET_ALLOW); }
static void load_nr(void) { stmt(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)); }
static void load_arg(unsigned n) { stmt(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args) + n * 8); }
static unsigned special(unsigned nr) {
  unsigned start = count;
  jump(BPF_JMP | BPF_JEQ | BPF_K, nr, 0, 0);
  return start;
}
static void end_special(unsigned start) {
  filter[start].jf = count - start - 1;
  load_nr();
}
static void allow_nr(unsigned nr) {
  jump(BPF_JMP | BPF_JEQ | BPF_K, nr, 0, 1);
  allowed();
}
static void limit(int resource, rlim_t value) {
  struct rlimit bound = { value, value };
  if (setrlimit(resource, &bound)) _exit(125);
}
static rlim_t setting(const char *name) {
  const char *raw = getenv(name);
  char *end = NULL;
  unsigned long long value = raw ? strtoull(raw, &end, 10) : 0;
  if (!value || !end || *end) _exit(125);
  unsetenv(name);
  return value;
}

__attribute__((constructor)) static void contain_before_runtime(void) {
  limit(RLIMIT_CORE, 0);
  limit(RLIMIT_AS, setting("YOUR_BOT_AS"));
  limit(RLIMIT_CPU, setting("YOUR_BOT_CPU"));
  limit(RLIMIT_FSIZE, setting("YOUR_BOT_FILE"));
  limit(RLIMIT_NOFILE, 64);
  limit(RLIMIT_STACK, 8 * 1024 * 1024);
  if (prctl(PR_SET_DUMPABLE, 0) || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) _exit(125);
  /* No inherited descriptors other than stdio and the bootstrap confirmation pipe. */
  if (syscall(SYS_close_range, 4u, ~0u, 0u)) {
    if (errno != ENOSYS) _exit(125);
    for (int fd = 4; fd < 65536; fd++) close(fd);
  }
  unsetenv("LD_PRELOAD");

  stmt(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch));
  jump(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0);
  stmt(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
  load_nr();
  jump(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1); /* Reject x32 ABI. */
  stmt(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);

  unsigned start = special(SYS_clone3);
  stmt(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS); /* libc falls back to clone. */
  end_special(start);
  start = special(SYS_clone);
  stmt(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args) + 4);
  jump(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0);
  denied();
  load_arg(0);
  const unsigned required = CLONE_THREAD | CLONE_VM | CLONE_SIGHAND;
  const unsigned permitted = required | CLONE_FS | CLONE_FILES | CLONE_SYSVSEM |
    CLONE_SETTLS | CLONE_PARENT_SETTID | CLONE_CHILD_SETTID | CLONE_CHILD_CLEARTID;
  stmt(BPF_ALU | BPF_AND | BPF_K, ~permitted);
  jump(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0);
  denied();
  load_arg(0);
  stmt(BPF_ALU | BPF_AND | BPF_K, required);
  jump(BPF_JMP | BPF_JEQ | BPF_K, required, 1, 0);
  denied();
  allowed();
  end_special(start);

  start = special(SYS_prctl);
  load_arg(0);
  allow_nr(PR_GET_NO_NEW_PRIVS);
  allow_nr(PR_GET_SECCOMP);
  allow_nr(PR_GET_NAME);
  allow_nr(PR_SET_NAME);
  denied();
  end_special(start);
  start = special(SYS_prlimit64);
  /* Query only, current process only. Hard limits cannot be raised or changed. */
  load_arg(0);
  jump(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0);
  denied();
  load_arg(2);
  jump(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0);
  denied();
  stmt(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args) + 2 * 8 + 4);
  jump(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0);
  denied();
  allowed();
  end_special(start);
  start = special(SYS_ioctl);
  load_arg(1);
  allow_nr(0x5401); /* TCGETS: runtime probes pipes, never sets terminal state. */
  allow_nr(0x802c542a); /* TCGETS2 */
  allow_nr(0x5413); /* TIOCGWINSZ */
  allow_nr(0x541b); /* FIONREAD */
  allow_nr(0x5421); /* FIONBIO */
  allow_nr(0x5451); /* FIOCLEX: set FD_CLOEXEC, used by Python/glibc fopen. */
  denied();
  end_special(start);

  /* Node's host-created stdio pipes are AF_UNIX sockets. Permit metadata queries
   * on stdio only, without ever permitting socket/socketpair/connect/bind. */
  const unsigned stdio_queries[] = { SYS_getsockname, SYS_getpeername, SYS_getsockopt };
  for (unsigned i = 0; i < sizeof(stdio_queries) / sizeof(stdio_queries[0]); i++) {
    start = special(stdio_queries[i]);
    load_arg(0);
    jump(BPF_JMP | BPF_JGT | BPF_K, 2, 1, 0);
    allowed();
    denied();
    end_special(start);
  }

  /* Positive allowlist: unknown/new syscalls fail EPERM. No process creation,
   * exec, sockets, ptrace, namespace/mount changes, io_uring, bpf, keyrings,
   * pidfd, process_vm, file handles, kernel administration or seccomp changes. */
  const unsigned safe[] = {
    SYS_read, SYS_write, SYS_readv, SYS_writev, SYS_pread64, SYS_pwrite64,
    SYS_close, SYS_close_range, SYS_open, SYS_openat, SYS_access, SYS_faccessat,
    SYS_faccessat2, SYS_stat, SYS_lstat, SYS_fstat, SYS_newfstatat, SYS_statx,
    SYS_lseek, SYS_getdents, SYS_getdents64, SYS_readlink, SYS_readlinkat,
    SYS_getcwd, SYS_chdir, SYS_fchdir, SYS_dup, SYS_dup2, SYS_dup3, SYS_fcntl,
    SYS_pipe, SYS_pipe2, SYS_poll, SYS_ppoll, SYS_select, SYS_pselect6,
    SYS_epoll_create, SYS_epoll_create1, SYS_epoll_ctl, SYS_epoll_wait,
    SYS_epoll_pwait, SYS_epoll_pwait2, SYS_eventfd, SYS_eventfd2,
    SYS_mmap, SYS_mprotect, SYS_munmap, SYS_mremap, SYS_brk, SYS_madvise,
    SYS_futex, SYS_futex_waitv, SYS_set_robust_list, SYS_get_robust_list,
    SYS_set_tid_address, SYS_rseq, SYS_rt_sigaction, SYS_rt_sigprocmask,
    SYS_rt_sigreturn, SYS_sigaltstack, SYS_rt_sigsuspend, SYS_rt_sigtimedwait,
    SYS_tgkill, SYS_sched_yield, SYS_sched_getaffinity,
    SYS_clock_gettime, SYS_clock_getres, SYS_clock_nanosleep, SYS_nanosleep,
    SYS_gettimeofday, SYS_time, SYS_getrandom, SYS_uname, SYS_sysinfo,
    SYS_getpid, SYS_getppid, SYS_gettid, SYS_getuid, SYS_geteuid,
    SYS_getgid, SYS_getegid, SYS_getgroups, SYS_getrlimit, SYS_getrusage,
    SYS_umask, SYS_fsync, SYS_fdatasync, SYS_ftruncate, SYS_truncate,
    SYS_mkdir, SYS_mkdirat, SYS_rmdir, SYS_unlink, SYS_unlinkat,
    SYS_rename, SYS_renameat, SYS_renameat2, SYS_link, SYS_linkat,
    SYS_symlink, SYS_symlinkat, SYS_chmod, SYS_fchmod, SYS_fchmodat,
    SYS_utime, SYS_utimes, SYS_utimensat, SYS_statfs, SYS_fstatfs,
    SYS_sendfile, SYS_copy_file_range, SYS_fallocate,
    SYS_arch_prctl, SYS_restart_syscall, SYS_exit, SYS_exit_group
  };
  for (unsigned i = 0; i < sizeof(safe) / sizeof(safe[0]); i++) allow_nr(safe[i]);
  denied();
  struct sock_fprog program = { (unsigned short)count, filter };
  if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_TSYNC, &program)) _exit(125);
  /* This happens only after irrevocable enforcement. No harness output is consumed here. */
  if (write(3, "YOUR_BOT_CONTAINED_V1\n", 22) != 22) _exit(125);
  close(3);
}
`;

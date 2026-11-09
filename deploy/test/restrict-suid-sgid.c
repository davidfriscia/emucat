/*
 * restrict-suid-sgid: runs a command under the seccomp filter that systemd installs for
 * RestrictSUIDSGID=yes (and, as NoNewPrivileges=yes, with no_new_privs set), so that the deployment tests
 * can reproduce that restriction in a container with no systemd. Built into the test image by
 * deploy/test/Dockerfile.
 *
 *   restrict-suid-sgid [--check] [--] command [argument...]
 *
 * The rules follow systemd's seccomp_restrict_suid_sgid() (src/shared/seccomp-util.c):
 *   - chmod, fchmod, fchmodat, fchmodat2, mkdir, mkdirat, mknod, mknodat and creat fail with EPERM when
 *     the mode asks for the set-user-ID or set-group-ID bit;
 *   - open and openat fail with EPERM when they would create a file (O_CREAT or O_TMPFILE) with either
 *     bit;
 *   - openat2 always fails with ENOSYS: its mode is inside struct open_how, which a seccomp filter cannot
 *     read, so systemd blocks the call to make the C library fall back to openat().
 * The last rule is the one GNU tar's extraction trips over.
 *
 * --check installs the filter, verifies that openat2() fails with ENOSYS and that adding the
 * set-group-ID bit to a file fails with EPERM, and then runs the command, if any.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef __NR_openat2
#define __NR_openat2 437
#endif
#ifndef __NR_fchmodat2
#define __NR_fchmodat2 452
#endif
#ifndef __O_TMPFILE
#define __O_TMPFILE 020000000
#endif

#if defined(__x86_64__)
#define NATIVE_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define NATIVE_ARCH AUDIT_ARCH_AARCH64
#else
#error "restrict-suid-sgid supports x86_64 and aarch64"
#endif

#define SUID_SGID (S_ISUID | S_ISGID)
#define ARG(n) (offsetof(struct seccomp_data, args) + (n) * sizeof(uint64_t))
#define MAX_FILTER 256

static struct sock_filter program[MAX_FILTER];
static unsigned short length;

static void emit(struct sock_filter instruction) {
  if (length == MAX_FILTER) {
    fputs("restrict-suid-sgid: filter too long\n", stderr);
    exit(125);
  }
  program[length++] = instruction;
}

/* The low 32 bits of a 64-bit argument (little-endian on both supported architectures), where the mode
 * and open flags are. */
static void load_arg(int n) { emit((struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, ARG(n))); }

/* EPERM when argument mode_arg has a set-ID bit and, with flags_arg >= 0, argument flags_arg creates a
 * file. */
static void deny_set_id(int nr, int mode_arg, int flags_arg) {
  int with_flags = flags_arg >= 0;
  emit((struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)));
  emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, nr, 0, with_flags ? 5 : 3));
  load_arg(mode_arg);
  emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, SUID_SGID, 0, with_flags ? 3 : 1));
  if (with_flags) {
    load_arg(flags_arg);
    emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, O_CREAT | __O_TMPFILE, 0, 1));
  }
  emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM));
}

static void install_filter(void) {
  emit((struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)));
  emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, NATIVE_ARCH, 1, 0));
  emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));

  emit((struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)));
  emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_openat2, 0, 1));
  emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS));

#ifdef __NR_chmod
  deny_set_id(__NR_chmod, 1, -1);
#endif
  deny_set_id(__NR_fchmod, 1, -1);
  deny_set_id(__NR_fchmodat, 2, -1);
  deny_set_id(__NR_fchmodat2, 2, -1);
#ifdef __NR_mkdir
  deny_set_id(__NR_mkdir, 1, -1);
#endif
  deny_set_id(__NR_mkdirat, 2, -1);
#ifdef __NR_mknod
  deny_set_id(__NR_mknod, 1, -1);
#endif
  deny_set_id(__NR_mknodat, 2, -1);
#ifdef __NR_creat
  deny_set_id(__NR_creat, 1, -1);
#endif
#ifdef __NR_open
  deny_set_id(__NR_open, 2, 1);
#endif
  deny_set_id(__NR_openat, 3, 2);

  emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));

  struct sock_fprog fprog = {.len = length, .filter = program};
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    perror("restrict-suid-sgid: PR_SET_NO_NEW_PRIVS");
    exit(125);
  }
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &fprog) != 0) {
    perror("restrict-suid-sgid: PR_SET_SECCOMP");
    exit(125);
  }
}

/* struct open_how from linux/openat2.h, which older headers lack. */
struct how {
  uint64_t flags, mode, resolve;
};

static int check(void) {
  int ok = 1;
  struct how how = {.flags = O_RDONLY | O_DIRECTORY};
  long fd = syscall(__NR_openat2, AT_FDCWD, ".", &how, sizeof how);
  if (fd >= 0 || errno != ENOSYS) {
    fprintf(stderr, "restrict-suid-sgid: openat2() was not refused with ENOSYS (%s)\n",
            fd >= 0 ? "it succeeded" : strerror(errno));
    ok = 0;
  }
  char path[] = "/tmp/restrict-suid-sgid.XXXXXX";
  int file = mkstemp(path);
  if (file < 0) {
    perror("restrict-suid-sgid: mkstemp");
    return 0;
  }
  if (fchmod(file, 02644) == 0 || errno != EPERM) {
    fprintf(stderr, "restrict-suid-sgid: fchmod(02644) was not refused with EPERM\n");
    ok = 0;
  }
  if (fchmod(file, 0644) != 0) {
    perror("restrict-suid-sgid: fchmod(0644) was refused");
    ok = 0;
  }
  close(file);
  unlink(path);
  return ok;
}

int main(int argc, char **argv) {
  int i = 1, verify = 0;
  if (i < argc && strcmp(argv[i], "--check") == 0) verify = 1, i++;
  if (i < argc && strcmp(argv[i], "--") == 0) i++;
  if (i >= argc && !verify) {
    fputs("usage: restrict-suid-sgid [--check] [--] command [argument...]\n", stderr);
    return 2;
  }
  install_filter();
  if (verify && !check()) return 125;
  if (i >= argc) return 0;
  execvp(argv[i], argv + i);
  fprintf(stderr, "restrict-suid-sgid: %s: %s\n", argv[i], strerror(errno));
  return 127;
}

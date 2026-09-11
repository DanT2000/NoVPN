/*
 * Запуск движка отдельным процессом с передачей ему TUN-дескриптора.
 *
 * Зачем вообще нативный код. Движок mihomo — обычный исполняемый файл, и ему
 * нужен файловый дескриптор туннеля, который выдал VpnService. Передать чужой
 * дескриптор дочернему процессу из Java нечем: ProcessBuilder отдаёт ребёнку
 * только stdin/stdout/stderr. Поэтому fork()+dup2() руками: в ребёнке TUN
 * кладётся на фиксированный номер, движок получает его в конфиге как
 * `tun.file-descriptor`.
 *
 * Между fork() и execve() в ребёнке можно вызывать только async-signal-safe
 * функции: процесс многопоточный (JVM), и любой malloc может встать намертво на
 * чужом залоченном мьютексе. Поэтому всё, что требует выделения памяти —
 * массивы argv/envp, открытие журнала — делается ДО fork().
 */

#include <jni.h>

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

/* Дескриптор, на котором движок ждёт туннель. Совпадает с Engine.TUN_FD. */
#define TUN_TARGET_FD 3

/* Закрываем всё лишнее, что могло утечь из JVM (сокеты, файлы, inotify).
   Верхняя граница взята с запасом: реальных дескрипторов у процесса единицы. */
#define MAX_FD 1024

static char *dup_utf(JNIEnv *env, jstring s) {
    if (s == NULL) return NULL;
    const char *chars = (*env)->GetStringUTFChars(env, s, NULL);
    if (chars == NULL) return NULL;
    char *copy = strdup(chars);
    (*env)->ReleaseStringUTFChars(env, s, chars);
    return copy;
}

/* Массив строк JNI → NULL-terminated char*[] (нужен execve). */
static char **dup_array(JNIEnv *env, jobjectArray arr, char *head) {
    jsize n = (arr == NULL) ? 0 : (*env)->GetArrayLength(env, arr);
    jsize extra = (head != NULL) ? 1 : 0;
    char **out = (char **) calloc((size_t) (n + extra + 1), sizeof(char *));
    if (out == NULL) return NULL;
    jsize at = 0;
    if (head != NULL) out[at++] = head;
    for (jsize i = 0; i < n; i++) {
        jstring item = (jstring) (*env)->GetObjectArrayElement(env, arr, i);
        out[at++] = dup_utf(env, item);
        if (item != NULL) (*env)->DeleteLocalRef(env, item);
    }
    out[at] = NULL;
    return out;
}

static void free_array(char **a) {
    if (a == NULL) return;
    for (char **p = a; *p != NULL; p++) free(*p);
    free(a);
}

/*
 * Запускает exe с аргументами args (argv[0] подставляем сами), рабочим каталогом
 * workDir, выводом в logPath и туннелем на дескрипторе TUN_TARGET_FD.
 * tunFd < 0 — без туннеля (режим «движок только как прокси»).
 * Возвращает pid или отрицательный код ошибки.
 */
JNIEXPORT jint JNICALL
Java_ru_appswire_novpn_vpn_Native_spawn(JNIEnv *env, jclass clazz,
                                        jstring jExe, jobjectArray jArgs,
                                        jobjectArray jEnv, jstring jWorkDir,
                                        jstring jLogPath, jint tunFd) {
    (void) clazz;

    char *exe = dup_utf(env, jExe);
    char *workDir = dup_utf(env, jWorkDir);
    char *logPath = dup_utf(env, jLogPath);
    char **argv = dup_array(env, jArgs, exe != NULL ? strdup(exe) : NULL);
    char **envp = dup_array(env, jEnv, NULL);

    if (exe == NULL || argv == NULL || envp == NULL) {
        free(exe); free(workDir); free(logPath);
        free_array(argv); free_array(envp);
        return -ENOMEM;
    }

    /* Журнал открываем в родителе: open() после fork() — уже не наш риск. */
    int logFd = -1;
    if (logPath != NULL) {
        logFd = open(logPath, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    }
    if (logFd < 0) {
        logFd = open("/dev/null", O_WRONLY);
    }
    int nullFd = open("/dev/null", O_RDONLY);

    pid_t pid = fork();
    if (pid == 0) {
        /* ---- ребёнок: только async-signal-safe вызовы ---- */
        if (tunFd >= 0) {
            if (tunFd != TUN_TARGET_FD) {
                if (dup2(tunFd, TUN_TARGET_FD) < 0) _exit(125);
            } else {
                /* dup2 на тот же номер не снимает CLOEXEC — снимаем руками,
                   иначе execve закроет туннель и движок увидит пустоту. */
                int flags = fcntl(TUN_TARGET_FD, F_GETFD);
                if (flags >= 0) fcntl(TUN_TARGET_FD, F_SETFD, flags & ~FD_CLOEXEC);
            }
        }
        if (nullFd >= 0) dup2(nullFd, STDIN_FILENO);
        if (logFd >= 0) {
            dup2(logFd, STDOUT_FILENO);
            dup2(logFd, STDERR_FILENO);
        }
        /* Всё, что выше туннеля, ребёнку не нужно и не должно утечь. */
        for (int fd = TUN_TARGET_FD + 1; fd < MAX_FD; fd++) close(fd);

        if (workDir != NULL) {
            if (chdir(workDir) != 0) _exit(126);
        }
        /* Сигналы могли прийти из JVM уже заблокированными — вернём норму. */
        sigset_t empty;
        sigemptyset(&empty);
        sigprocmask(SIG_SETMASK, &empty, NULL);
        signal(SIGPIPE, SIG_DFL);

        execve(exe, argv, envp);
        _exit(127);
    }

    /* ---- родитель ---- */
    int err = errno;
    if (logFd >= 0) close(logFd);
    if (nullFd >= 0) close(nullFd);
    free(workDir);
    free(logPath);
    free(exe);
    free_array(argv);
    free_array(envp);

    if (pid < 0) return -err;
    return (jint) pid;
}

/*
 * Состояние процесса. block=false — опрос без ожидания.
 * ≥0 — код выхода; -1 — ещё работает; -2 — процесса нет (уже подобран/чужой).
 */
JNIEXPORT jint JNICALL
Java_ru_appswire_novpn_vpn_Native_waitPid(JNIEnv *env, jclass clazz, jint pid, jboolean block) {
    (void) env; (void) clazz;
    int status = 0;
    pid_t r = waitpid((pid_t) pid, &status, block ? 0 : WNOHANG);
    if (r == 0) return -1;
    if (r < 0) return -2;
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return -3;
}

JNIEXPORT jint JNICALL
Java_ru_appswire_novpn_vpn_Native_killPid(JNIEnv *env, jclass clazz, jint pid, jint sig) {
    (void) env; (void) clazz;
    if (pid <= 0) return -EINVAL;
    if (kill((pid_t) pid, sig) != 0) return -errno;
    return 0;
}

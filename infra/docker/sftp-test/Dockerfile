# A real OpenSSH server, for tests only. It runs an account restricted the way the repository guide
# recommends: SFTP only, chrooted, and with public-key authentication alone. Nothing here is suitable
# for production, since the host key is passed in by the test that starts it.
FROM alpine:3.22

RUN apk add --no-cache openssh-server openssh-sftp-server procps

RUN adduser -D -u 1000 -s /sbin/nologin emucat \
  && passwd -u emucat \
  && mkdir -p /srv/sftp/repo /etc/ssh/keys /run/sshd \
  && chown root:root /srv/sftp \
  && chmod 755 /srv/sftp \
  && chown emucat:emucat /srv/sftp/repo

COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]

# Local TLS test fixtures

`server-cert.pem` is a self-signed certificate for `chat-logger.invalid` and IP `127.0.0.1`.
`server-key.pem` is its public test-only private key. Never use it for a deployed service.
Both were generated for this module's isolated loopback unit tests, using:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 36500 \
  -subj '/CN=chat-logger.invalid' \
  -addext 'subjectAltName=DNS:chat-logger.invalid,IP:127.0.0.1' \
  -keyout server-key.pem -out server-cert.pem
```

The tests verify rejection of an untrusted certificate, acceptance with the explicit CA file,
and rejection when the trusted certificate's hostname does not match (`localhost`).

# Extension signing keys

`extension.pem` — RSA 2048 private key used to sign the self-hosted CRX file.

**Do not commit.** Extension ID is derived from the public key; rotating this key
changes the ID and breaks every already-installed copy.

Extension ID (stable, forever): `cbkmghnncpgkoedbppgimdidbkffnbij`

To re-derive the public key (for `manifest.json#key`):

```bash
openssl rsa -in extension.pem -pubout -outform DER 2>/dev/null | openssl base64 -A
```

To re-derive the extension ID:

```bash
openssl rsa -in extension.pem -pubout -outform DER 2>/dev/null \
  | openssl dgst -sha256 -hex | sed -E 's/^.*= //' | cut -c1-32 | tr '0-9a-f' 'a-p'
```

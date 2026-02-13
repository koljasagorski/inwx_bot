This project is a bot for [INWX.de](https://github.com/inwx) that checks the availability of domains. If a domain is available, the bot automatically registers it through the INWX API.

## install dependencies
pip install -r requirements.txt

## Zugangsdaten konfigurieren
Trage deine Zugangsdaten in `.env.sample` ein und benenne die Datei in `.env` um.

Die meisten Daten für die Domain-Registrierung werden automatisch abgerufen.
Wenn du eigene Parameter verwenden möchtest, trage sie in der `.env` ein und übergib sie an die Kauffunktion.

## 2FA / Zwei-Faktor-Authentifizierung

Wenn in deinem INWX-Account 2FA aktiviert ist, musst du das **Shared Secret** in der `.env` hinterlegen. Das ist der Base32-String, der beim Einrichten von 2FA angezeigt wird (derselbe String, den du in Google Authenticator, Authy o.ä. scannst/eingibst).

```
shared_secret = 'DEIN_BASE32_SECRET'
```

Der Bot generiert daraus bei jedem Login automatisch den aktuellen 6-stelligen TOTP-Code — du musst also keinen Code manuell eingeben.

Wenn du **keine 2FA** nutzt, lass das Feld einfach leer (`shared_secret = ''`). Der Login funktioniert dann wie gewohnt nur mit Username und Passwort.

## start script

## Todo
- [ ] Optionale Argumente für die Domain-Registrierung implementieren

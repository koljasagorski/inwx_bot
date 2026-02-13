import logging
import os
import csv
from dotenv import load_dotenv
from INWX.Domrobot import ApiClient

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    filename="log.txt",
    format='%(asctime)s %(levelname)s:%(message)s')

# Load environment variables
load_dotenv()

# Initialize API client
api_client = ApiClient(api_url=ApiClient.API_LIVE_URL, debug_mode=False)

# Utility function to log errors and raise exceptions
def log_and_raise_error(code, message, context=""):
    error_message = f"API error {context}. Code: {code}, Message: {message}"
    logging.error(error_message)
    raise Exception(error_message)

def login(username, password, shared_secret=None):
    """Login to INWX (mit optionalem 2FA/TOTP)"""
    login_result = api_client.login(username, password, shared_secret=shared_secret or None)
    if login_result['code'] == 1000:
        logging.info("Login successful.")
        return login_result
    else:
        log_and_raise_error(login_result['code'], login_result['msg'], "during login")

def is_domain_free(domain_name):
    """Check if the domain is available"""
    domain_check_result = api_client.call_api('domain.check', {'domain': domain_name})
    if domain_check_result['code'] == 1000:
        checked_domain = domain_check_result['resData']['domain'][0]
        return bool(checked_domain.get('avail', False))
    else:
        log_and_raise_error(domain_check_result['code'], domain_check_result.get('msg', ''), "during domain check")

def get_account_info():
    """Get account information required to buy a domain"""
    account_info_result = api_client.call_api('account.info')
    if account_info_result['code'] == 1000:
        logging.info("Account info retrieved successfully.")
        return account_info_result['resData']
    else:
        log_and_raise_error(account_info_result['code'], account_info_result.get('msg', ''), "while fetching account info")

def buy_domain(buy_params):
    """Buy a domain (returns (success, code, msg))"""
    domain_buy_result = api_client.call_api('domain.create', buy_params)
    code = domain_buy_result.get('code')
    msg = domain_buy_result.get('msg', '')
    if code == 1000:
        logging.info(f"Domain {buy_params['domain']} purchased successfully.")
        return True, code, msg
    else:
        logging.error(f"Failed to purchase domain {buy_params['domain']}. Code: {code}, Message: {msg}")
        return False, code, msg

def print_live_status(idx, total, domain, status, detail=""):
    prefix = f"[{idx}/{total}] {domain:<40}"
    line = f"{prefix} → {status}"
    if detail:
        line += f" — {detail}"
    print(line)

def main():
    statuses = []  # collect status per domain for summary + CSV
    try:
        # Login
        username = os.getenv('username')
        password = os.getenv('password')
        shared_secret = os.getenv('shared_secret')
        if not username or not password:
            raise ValueError("Username or password not set in environment variables.")
        login(username, password, shared_secret=shared_secret)

        # Get account info
        account_info = get_account_info()

        # Nameserver (optional): only include if set & non-empty
        ns_env = [os.getenv('ns1'), os.getenv('ns2')]
        ns = [v for v in ns_env if v]  # filter None/empty

        # Read domain list from file
        with open("domains.txt", encoding='utf-8') as file:
            domains = [d.strip() for d in file.read().splitlines() if d.strip()]

        total = len(domains)
        if total == 0:
            print("Keine Domains in domains.txt gefunden.")
            return

        print(f"Prüfe {total} Domains bei INWX …\n")

        # Process domains
        for i, domain in enumerate(domains, start=1):
            try:
                available = is_domain_free(domain)
                if available:
                    print_live_status(i, total, domain, "VERFÜGBAR", "Kaufe…")
                    buy_params = {
                        'domain': domain,
                        'registrant': account_info['defaultRegistrant'],
                        'admin': account_info['defaultAdmin'],
                        'tech': account_info['defaultTech'],
                        'billing': account_info['defaultBilling'],
                    }
                    if ns:
                        buy_params['ns'] = ns

                    success, code, msg = buy_domain(buy_params)
                    if success:
                        print_live_status(i, total, domain, "GEKAUFT", "Command completed successfully")
                        statuses.append({
                            'domain': domain,
                            'available': True,
                            'action': 'purchased',
                            'detail': 'success',
                            'api_code': code,
                            'api_msg': msg
                        })
                    else:
                        print_live_status(i, total, domain, "KAUF FEHLGESCHLAGEN", f"Code {code}: {msg}")
                        statuses.append({
                            'domain': domain,
                            'available': True,
                            'action': 'purchase_failed',
                            'detail': f"Code {code}: {msg}",
                            'api_code': code,
                            'api_msg': msg
                        })
                else:
                    print_live_status(i, total, domain, "NICHT VERFÜGBAR")
                    statuses.append({
                        'domain': domain,
                        'available': False,
                        'action': 'skipped',
                        'detail': 'already registered',
                        'api_code': 1000,
                        'api_msg': 'domain not available'
                    })
            except Exception as e:
                print_live_status(i, total, domain, "FEHLER", str(e))
                statuses.append({
                    'domain': domain,
                    'available': None,
                    'action': 'error',
                    'detail': str(e),
                    'api_code': None,
                    'api_msg': None
                })

        # Logout
        api_client.logout()
        logging.info("Logout successful.")

    except Exception as e:
        logging.error(f"An error occurred: {e}")
        print(f"\nAbbruch: {e}")
        return

    # Summary table
    print("\nZusammenfassung:")
    header = f"{'Domain':40} {'Avail':5} {'Action':16} {'Detail'}"
    print(header)
    print("-" * len(header))
    for s in statuses:
        avail = {True: "yes", False: "no"}.get(s['available'], "-")
        detail = s['detail'] or ""
        print(f"{s['domain']:40} {avail:5} {s['action']:16} {detail}")

    # CSV export
    try:
        with open("domain_status.csv", "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=["domain","available","action","detail","api_code","api_msg"])
            writer.writeheader()
            writer.writerows(statuses)
        print('\nCSV gespeichert: domain_status.csv')
    except Exception as e:
        logging.error(f"Failed to write CSV: {e}")
        print(f"\nKonnte CSV nicht schreiben: {e}")

if __name__ == "__main__":
    main()

import logging
import os
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

def login(username, password):
    """Login to INWX"""
    login_result = api_client.login(username, password)
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
        if checked_domain['avail']:
            logging.info(f"Domain {domain_name} is available.")
            return True
        else:
            logging.info(f"Domain {domain_name} is not available.")
            return False
    else:
        log_and_raise_error(domain_check_result['code'], domain_check_result['msg'], "during domain check")
        return False

def get_account_info():
    """Get account information required to buy a domain"""
    account_info_result = api_client.call_api('account.info')
    if account_info_result['code'] == 1000:
        logging.info("Account info retrieved successfully.")
        return account_info_result['resData']
    else:
        log_and_raise_error(account_info_result['code'], account_info_result['msg'], "while fetching account info")

def buy_domain(buy_params):
    """Buy a domain"""
    domain_buy_result = api_client.call_api('domain.create', buy_params)
    if domain_buy_result['code'] == 1000:
        logging.info(f"Domain {buy_params['domain']} purchased successfully.")
        return True
    else:
        logging.error(f"Failed to purchase domain {buy_params['domain']}. Code: {domain_buy_result['code']}, Message: {domain_buy_result['msg']}")
        return False

def main():
    try:
        # Login
        username = os.getenv('username')
        password = os.getenv('password')
        if not username or not password:
            raise ValueError("Username or password not set in environment variables.")
        
        login(username, password)
        
        # Get account info
        account_info = get_account_info()
        
        # Read domain list from file
        with open("domains.txt", encoding='utf-8') as file:
            domains = file.read().splitlines()
        
        # Process domains
        for domain in domains:
            if is_domain_free(domain):
                buy_domain({
                    'domain': domain,
                    'registrant': account_info['defaultRegistrant'],
                    'admin': account_info['defaultAdmin'],
                    'tech': account_info['defaultTech'],
                    'billing': account_info['defaultBilling'],
                    'ns': [os.getenv('ns1'), os.getenv('ns2')]
                })
        
        # Logout
        api_client.logout()
        logging.info("Logout successful.")
    
    except Exception as e:
        logging.error(f"An error occurred: {e}")

if __name__ == "__main__":
    main()

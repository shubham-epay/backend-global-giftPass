/**
 * ISO 3166-1 alpha-2 reference list: "CODE|Name|Currency|alias;alias".
 * Used to resolve country names/codes in imports and to pre-fill new countries in the admin.
 */
const RAW = `
AD|Andorra|EUR
AE|United Arab Emirates|AED|UAE;U.A.E.;Emirates
AF|Afghanistan|AFN
AG|Antigua and Barbuda|XCD
AL|Albania|ALL
AM|Armenia|AMD
AO|Angola|AOA
AR|Argentina|ARS
AT|Austria|EUR
AU|Australia|AUD
AZ|Azerbaijan|AZN
BA|Bosnia and Herzegovina|BAM
BB|Barbados|BBD
BD|Bangladesh|BDT
BE|Belgium|EUR
BF|Burkina Faso|XOF
BG|Bulgaria|BGN
BH|Bahrain|BHD
BI|Burundi|BIF
BJ|Benin|XOF
BN|Brunei|BND|Brunei Darussalam
BO|Bolivia|BOB
BR|Brazil|BRL
BS|Bahamas|BSD|The Bahamas
BT|Bhutan|BTN
BW|Botswana|BWP
BY|Belarus|BYN
BZ|Belize|BZD
CA|Canada|CAD
CD|Democratic Republic of the Congo|CDF|DR Congo;Congo-Kinshasa
CF|Central African Republic|XAF
CG|Republic of the Congo|XAF|Congo;Congo-Brazzaville
CH|Switzerland|CHF
CI|Côte d'Ivoire|XOF|Ivory Coast;Cote d'Ivoire
CL|Chile|CLP
CM|Cameroon|XAF
CN|China|CNY|PRC;People's Republic of China
CO|Colombia|COP
CR|Costa Rica|CRC
CU|Cuba|CUP
CV|Cape Verde|CVE|Cabo Verde
CY|Cyprus|EUR
CZ|Czechia|CZK|Czech Republic
DE|Germany|EUR|Deutschland
DJ|Djibouti|DJF
DK|Denmark|DKK
DM|Dominica|XCD
DO|Dominican Republic|DOP
DZ|Algeria|DZD
EC|Ecuador|USD
EE|Estonia|EUR
EG|Egypt|EGP
ER|Eritrea|ERN
ES|Spain|EUR|España
ET|Ethiopia|ETB
FI|Finland|EUR
FJ|Fiji|FJD
FM|Micronesia|USD
FR|France|EUR
GA|Gabon|XAF
GB|United Kingdom|GBP|UK;U.K.;Great Britain;Britain;England;GB
GD|Grenada|XCD
GE|Georgia|GEL
GH|Ghana|GHS
GM|Gambia|GMD|The Gambia
GN|Guinea|GNF
GQ|Equatorial Guinea|XAF
GR|Greece|EUR
GT|Guatemala|GTQ
GW|Guinea-Bissau|XOF
GY|Guyana|GYD
HK|Hong Kong|HKD
HN|Honduras|HNL
HR|Croatia|EUR
HT|Haiti|HTG
HU|Hungary|HUF
ID|Indonesia|IDR
IE|Ireland|EUR
IL|Israel|ILS
IN|India|INR|Bharat
IQ|Iraq|IQD
IR|Iran|IRR
IS|Iceland|ISK
IT|Italy|EUR|Italia
JM|Jamaica|JMD
JO|Jordan|JOD
JP|Japan|JPY
KE|Kenya|KES
KG|Kyrgyzstan|KGS
KH|Cambodia|KHR
KI|Kiribati|AUD
KM|Comoros|KMF
KN|Saint Kitts and Nevis|XCD
KP|North Korea|KPW
KR|South Korea|KRW|Korea;Republic of Korea
KW|Kuwait|KWD
KZ|Kazakhstan|KZT
LA|Laos|LAK
LB|Lebanon|LBP
LC|Saint Lucia|XCD
LI|Liechtenstein|CHF
LK|Sri Lanka|LKR
LR|Liberia|LRD
LS|Lesotho|LSL
LT|Lithuania|EUR
LU|Luxembourg|EUR
LV|Latvia|EUR
LY|Libya|LYD
MA|Morocco|MAD
MC|Monaco|EUR
MD|Moldova|MDL
ME|Montenegro|EUR
MG|Madagascar|MGA
MH|Marshall Islands|USD
MK|North Macedonia|MKD|Macedonia
ML|Mali|XOF
MM|Myanmar|MMK|Burma
MN|Mongolia|MNT
MO|Macau|MOP|Macao
MR|Mauritania|MRU
MT|Malta|EUR
MU|Mauritius|MUR
MV|Maldives|MVR
MW|Malawi|MWK
MX|Mexico|MXN
MY|Malaysia|MYR
MZ|Mozambique|MZN
NA|Namibia|NAD
NE|Niger|XOF
NG|Nigeria|NGN
NI|Nicaragua|NIO
NL|Netherlands|EUR|Holland;The Netherlands
NO|Norway|NOK
NP|Nepal|NPR
NR|Nauru|AUD
NZ|New Zealand|NZD
OM|Oman|OMR
PA|Panama|PAB
PE|Peru|PEN
PG|Papua New Guinea|PGK
PH|Philippines|PHP
PK|Pakistan|PKR
PL|Poland|PLN
PS|Palestine|ILS
PT|Portugal|EUR
PW|Palau|USD
PY|Paraguay|PYG
QA|Qatar|QAR
RO|Romania|RON
RS|Serbia|RSD
RU|Russia|RUB|Russian Federation
RW|Rwanda|RWF
SA|Saudi Arabia|SAR|KSA;Kingdom of Saudi Arabia;Saudi
SB|Solomon Islands|SBD
SC|Seychelles|SCR
SD|Sudan|SDG
SE|Sweden|SEK
SG|Singapore|SGD
SI|Slovenia|EUR
SK|Slovakia|EUR
SL|Sierra Leone|SLE
SM|San Marino|EUR
SN|Senegal|XOF
SO|Somalia|SOS
SR|Suriname|SRD
SS|South Sudan|SSP
ST|São Tomé and Príncipe|STN|Sao Tome and Principe
SV|El Salvador|USD
SY|Syria|SYP
SZ|Eswatini|SZL|Swaziland
TD|Chad|XAF
TG|Togo|XOF
TH|Thailand|THB
TJ|Tajikistan|TJS
TL|Timor-Leste|USD|East Timor
TM|Turkmenistan|TMT
TN|Tunisia|TND
TO|Tonga|TOP
TR|Türkiye|TRY|Turkey
TT|Trinidad and Tobago|TTD
TV|Tuvalu|AUD
TW|Taiwan|TWD
TZ|Tanzania|TZS
UA|Ukraine|UAH
UG|Uganda|UGX
US|United States|USD|USA;U.S.A.;US;U.S.;United States of America;America
UY|Uruguay|UYU
UZ|Uzbekistan|UZS
VA|Vatican City|EUR|Holy See
VC|Saint Vincent and the Grenadines|XCD
VE|Venezuela|VES
VN|Vietnam|VND|Viet Nam
VU|Vanuatu|VUV
WS|Samoa|WST
YE|Yemen|YER
ZA|South Africa|ZAR
ZM|Zambia|ZMW
ZW|Zimbabwe|ZWL
`;

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

const COUNTRIES = RAW.trim().split('\n').map((line) => {
  const [code, name, currency, aliases = ''] = line.split('|');
  return { code, name, currency, aliases: aliases ? aliases.split(';') : [] };
});

const LOOKUP = new Map();
for (const c of COUNTRIES) {
  for (const key of [c.code, c.name, ...c.aliases]) {
    const k = norm(key);
    if (k && !LOOKUP.has(k)) LOOKUP.set(k, c);
  }
}

/** "UAE" | "ae" | "United States of America" -> { code, name, currency } or null. */
const findIsoCountry = (value) => LOOKUP.get(norm(value)) || null;

/** "AE" -> "🇦🇪" (regional indicator symbols). */
const flagOf = (code) => (/^[A-Z]{2}$/i.test(code || '')
  ? String.fromCodePoint(...code.toUpperCase().split('').map((ch) => 127397 + ch.charCodeAt(0)))
  : '');

module.exports = { COUNTRIES, findIsoCountry, flagOf, normCountry: norm };

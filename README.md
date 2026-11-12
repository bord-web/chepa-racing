# Chepa Racing

Тюнерський дашборд для BMW з iDrive 7 (MGU): температури, тиск наддуву з цільовим, етанол,
перемикання мап MHD, детонація й пропуски запалювання по циліндрах, графік «наддув проти цілі»,
тиск і температура шин, журнал заїздів.

*A tuner dashboard for BMW iDrive 7 (MGU) head units: temperatures, boost vs target, ethanol,
MHD map switching, knock and misfires per cylinder, tyres, pull log. English below.*

<img src="apps/chepa_racing/icon.png" alt="Chepa Racing" width="140">

## Встановлення через MGU Store

На машині потрібен встановлений [MGU Store](https://github.com/robertnisipeanu/mgu-store).

1. **MGU Store → Settings → Add source**, введіть адресу цього репозиторію (`owner/repo` або
   посилання на сторінку).
2. Що відстежувати: гілка **main**.
3. У списку з'явиться **Chepa Racing** → **Install**. Головний блок сам збирає застосунок зі
   своїм BMW SDK, це займає приблизно хвилину. Потім плитка з'являється в розділі **Apps**.

Коли тут з'являється нова версія, Store пропонує оновлення. Саме воно ніколи не встановлюється.

## Важливо

- **Перемикання мап MHD** за замовчуванням вимкнене: налаштування *Map switching* стоїть на
  *Simulated (nothing is sent)*. Режим *MHD: send to the DME* надсилає команди в DME.
  Вмикайте його лише якщо знаєте, що робите, і на власну відповідальність.
- У репозиторії немає коду BMW: SDK головний блок бере зі своєї прошивки під час збірки.

## English

Install: **MGU Store → Settings → Add source**, enter this repository (`owner/repo` or its link),
follow the **main** branch, then install **Chepa Racing**. The head unit builds the app itself
with its own BMW SDK, so there is no BMW code in this repository. MHD map switching is off
(*Simulated*) until you set *Map switching* to *MHD: send to the DME*; use that at your own risk.

## Ліцензія / Licence

MIT (`LICENSE`). Built on the [idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps)
kit (MIT). The fonts in `kit/runtime/fonts` are baked from the Ubuntu font family (Ubuntu Font
Licence) and Noto Sans SC (SIL OFL, `kit/runtime/fonts/OFL-NotoSansSC.txt`).

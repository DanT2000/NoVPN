; Дополнения к установщику NoVPN.
;
; Выбор папки, папка в «Пуске» и галочка ярлыка на рабочем столе есть в
; стандартном шаблоне Tauri. Здесь только то, чего в нём нет.

!macro NSIS_HOOK_PREINSTALL
  ; Запоминаем прежнее место установки ДО того, как основной раздел перепишет
  ; ключ производителя на новое. Понадобится, если человек сменил папку.
  ReadRegStr $R8 HKCU "Software\NoVPN\NoVPN" ""
  WriteRegStr HKCU "Software\NoVPN" "PrevDir" $R8

  ; -- Папка, в которую нельзя писать --------------------------------------
  ; Установщик берёт путь из реестра прошлой установки (RestorePreviousInstallLocation
  ; в шаблоне) и перекрывает им пользовательскую папку по умолчанию. У тех, кто когда-то
  ; ставил старую версию в «C:\Program Files\NoVPN», в реестре остаётся именно этот путь,
  ; а ставимся мы теперь ДЛЯ ПОЛЬЗОВАТЕЛЯ, без прав администратора: распаковка падает с
  ; «невозможно открыть файл для записи», и человек упирается в стену. Проверяем папку
  ; на запись и, если писать некуда, уводим установку в пользовательскую.
  ClearErrors
  CreateDirectory "$INSTDIR"
  FileOpen $R7 "$INSTDIR\.novpn-write-test" w
  IfErrors novpn_dir_bad
    FileClose $R7
    Delete "$INSTDIR\.novpn-write-test"
    Goto novpn_dir_ok
  novpn_dir_bad:
    DetailPrint "В «$INSTDIR» нет прав на запись — ставим в «$LOCALAPPDATA\${PRODUCTNAME}»"
    StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
    CreateDirectory "$INSTDIR"
    ; ОБЯЗАТЕЛЬНО: SetOutPath в шаблоне стоит СТРОКОЙ ВЫШЕ этого хука, и она уже
    ; запомнила прежнюю папку. Без повторного вызова файлы распакуются туда же,
    ; куда мы писать не можем (проверено: в новую папку попадал только
    ; деинсталлятор, а приложения не было вовсе).
    SetOutPath "$INSTDIR"
  novpn_dir_ok:

  ; Перед установкой поверх — гасим работающие процессы, иначе NSIS не сможет
  ; перезаписать exe и dll, которые они держат открытыми (taskkill по имени
  ; гасит и старую копию из другой папки).
  nsExec::Exec 'taskkill /F /IM ${MAINBINARYNAME}.exe /T'
  nsExec::Exec 'taskkill /F /IM mihomo.exe'
  Sleep 800

  ; taskkill возвращает управление РАНЬШЕ, чем система закрывает дескрипторы файлов
  ; (движок держит и wintun.dll, и свой exe). Из-за этого распаковка падала с
  ; «невозможно открыть файл для записи: Прервать / Повтор / Пропустить». Ждём, пока
  ; главный файл реально станет доступен на запись — до 10 секунд, дальше идём как есть.
  StrCpy $R6 0
  novpn_wait_free:
    IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 novpn_free
    ClearErrors
    FileOpen $R5 "$INSTDIR\${MAINBINARYNAME}.exe" a
    IfErrors novpn_locked 0
      FileClose $R5
      Goto novpn_free
  novpn_locked:
    IntOp $R6 $R6 + 1
    IntCmp $R6 20 novpn_free novpn_sleep novpn_free
  novpn_sleep:
    Sleep 500
    Goto novpn_wait_free
  novpn_free:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; ── Смена папки установки ──────────────────────────────────────────────
  ; Если папку сменили, старая установка осталась бы сиротой, а автозапуск
  ; (ключ Run и задача планировщика) указывал бы на старый путь — после его
  ; удаления Windows писала бы «не удалось найти файл». Убираем старую папку и
  ; мёртвую задачу; ключ Run чиним ниже. Задачу приложение пересоздаст с новым
  ; путём при первом запуске.
  ReadRegStr $R8 HKCU "Software\NoVPN" "PrevDir"
  StrCmp $R8 "" novpn_moved_done
  StrCmp $R8 "$INSTDIR" novpn_moved_done
    IfFileExists "$R8\uninstall.exe" 0 novpn_moved_done
      RMDir /r "$R8"
      nsExec::Exec 'schtasks /Delete /TN "NoVPN Autostart" /F'
  novpn_moved_done:
  DeleteRegValue HKCU "Software\NoVPN" "PrevDir"

  ; -- Автозапуск ---------------------------------------------------------
  ; Если ключ Run уже есть — ЧИНИМ путь на новую папку (мог смениться при переносе).
  ; САМИ автозапуск НЕ заводим. Раньше заводили при первой установке, и это выходило
  ; боком дважды: человек не просил запуск вместе с Windows, а для антивируса связка
  ; «неподписанный exe в AppData + ключ Run, созданный установщиком» — признак
  ; закрепления в системе (Defender: Behavior:Win32/Persistence.A!ml, файл блокируется
  ; и установка перестаёт проходить). Автозапуск включается в настройках приложения.
  ReadRegStr $R9 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "NoVPN"
  StrCmp $R9 "" novpn_run_done 0
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "NoVPN" '"$INSTDIR\${MAINBINARYNAME}.exe"'
  novpn_run_done:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Перед удалением завершаем приложение и движок: иначе они держат свои файлы,
  ; удаление проходит частично, а mihomo.exe остаётся жить и держит прокси.
  nsExec::Exec 'taskkill /F /IM ${MAINBINARYNAME}.exe /T'
  nsExec::Exec 'taskkill /F /IM mihomo.exe'
  Sleep 800
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "NoVPN"

  ; Тихая задача автозапуска режима адаптера. Без этого после удаления система
  ; при каждом входе пыталась бы запустить несуществующий exe с правами.
  nsExec::Exec 'schtasks /Delete /TN "NoVPN Autostart" /F'

  ; Записи хоста для расширения: без них браузер будет искать удалённый файл.
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\ru.appswire.novpn"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\ru.appswire.novpn"
  DeleteRegKey HKCU "Software\Yandex\YandexBrowser\NativeMessagingHosts\ru.appswire.novpn"
  DeleteRegKey HKCU "Software\Chromium\NativeMessagingHosts\ru.appswire.novpn"

  ; Возврат системного прокси. Если человек удаляет приложение, не отключившись,
  ; прокси остаётся указывать на порт, которого больше нет, и интернет пропадает.
  ; Трогаем, только если прокси указывает на НАШ порт — чужой клиент не сбрасываем.
  ;
  ; Приложение при подключении дублирует прежний прокси в HKCU\Software\NoVPN\
  ; ProxyBackup (JSON в %APPDATA% NSIS прочитать не может). Если там записано,
  ; что до нас стоял ЧУЖОЙ прокси (Had=1) — возвращаем именно его, а не просто
  ; выключаем. Иначе корпоративный/родительский прокси был бы стёрт.
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" "ProxyServer"
  StrCmp $0 "127.0.0.1:7893" 0 novpn_skip_proxy
    ReadRegDWORD $1 HKCU "Software\NoVPN\ProxyBackup" "Had"
    StrCmp $1 "1" novpn_restore_prev novpn_clear_proxy

    novpn_restore_prev:
      ReadRegDWORD $2 HKCU "Software\NoVPN\ProxyBackup" "Enable"
      ReadRegStr   $3 HKCU "Software\NoVPN\ProxyBackup" "Server"
      ReadRegStr   $4 HKCU "Software\NoVPN\ProxyBackup" "Override"
      WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" "ProxyEnable" $2
      StrCmp $3 "" 0 novpn_srv_set
        DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" "ProxyServer"
        Goto novpn_ovr
      novpn_srv_set:
        WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" "ProxyServer" $3
      novpn_ovr:
      StrCmp $4 "" 0 novpn_ovr_set
        DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" "ProxyOverride"
        Goto novpn_proxy_done
      novpn_ovr_set:
        WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" "ProxyOverride" $4
      Goto novpn_proxy_done

    novpn_clear_proxy:
      WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" "ProxyEnable" 0
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" "ProxyServer"
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" "ProxyOverride"

    novpn_proxy_done:
      System::Call 'wininet::InternetSetOptionW(i 0, i 39, i 0, i 0)'
      System::Call 'wininet::InternetSetOptionW(i 0, i 37, i 0, i 0)'
  novpn_skip_proxy:

  ; Ключ бэкапа прокси нам больше не нужен.
  DeleteRegKey HKCU "Software\NoVPN\ProxyBackup"

  ; Папку данных предлагаем удалить пользователю на странице подтверждения
  ; (стандартный флаг Tauri $DeleteAppDataCheckboxState). Если он согласился —
  ; сносим всё: настройки, подписку, списки, логи, манифест хоста.
  ${If} $DeleteAppDataCheckboxState == 1
    RMDir /r "$APPDATA\NoVPN"
  ${EndIf}
!macroend

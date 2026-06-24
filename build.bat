@echo off
echo Compiling SDCMS Backend...

REM Check if cl (MSVC) is available in current session
where cl >nul 2>nul
if %ERRORLEVEL% == 0 goto MSVC_BUILD

REM If not in PATH, try to find vcvars64.bat
echo MSVC not in PATH, searching for vcvars64.bat...
set "VS_PATH="
for /d %%i in ("C:\Program Files\Microsoft Visual Studio\*") do (
    for /d %%j in ("%%i\*") do (
        if exist "%%j\VC\Auxiliary\Build\vcvars64.bat" (
            set "VS_PATH=%%j\VC\Auxiliary\Build\vcvars64.bat"
        )
    )
)

if not "%VS_PATH%"=="" (
    echo Found VS environment setup script: "%VS_PATH%"
    call "%VS_PATH%"
    goto MSVC_BUILD
)

REM Check if g++ (MinGW) is available
where g++ >nul 2>nul
if %ERRORLEVEL% == 0 (
    echo Using MinGW compiler (g++)
    gcc -c src\sqlite3.c -o src\sqlite3.o
    g++ -std=c++17 src\main.cpp src\Database.cpp src\sqlite3.o -I include -o sdcms_server.exe -lws2_32 -lwsock32
    if %ERRORLEVEL% == 0 (
        echo Build successful. Run sdcms_server.exe
    ) else (
        echo Build failed.
    )
    exit /b
)

echo No C++ compiler found. Please install Visual Studio Build Tools (C++) or MinGW-w64.
pause
exit /b

:MSVC_BUILD
echo Using MSVC compiler (cl)
cl /EHsc /std:c++17 /O2 /Fe:sdcms_server.exe src\main.cpp src\Database.cpp src\sqlite3.c /I include
if %ERRORLEVEL% == 0 (
    echo Build successful. Run sdcms_server.exe
) else (
    echo Build failed.
)
exit /b

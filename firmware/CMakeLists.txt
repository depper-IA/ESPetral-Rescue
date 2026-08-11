# CALI Rescue System - CSI Motion Detection Firmware
# Requires ESP-IDF v5.x
# Target-agnostic: compila para ESP32-S3, ESP32-C6 o ESP32-C3 vía
#   idf.py set-target esp32s3  (o esp32c6 / esp32c3)
# El API CSI y la lógica de detección son idénticas entre los 3 targets.

cmake_minimum_required(VERSION 3.16)

set(EXTRA_COMPONENT_DIRS "")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(cali_csi_node)

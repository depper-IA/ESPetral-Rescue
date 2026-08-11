# CALI Rescue System - ESP32-C6 CSI Motion Detection Firmware
# Requires ESP-IDF v5.x

cmake_minimum_required(VERSION 3.16)

set(EXTRA_COMPONENT_DIRS "")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(cali_csi_node)

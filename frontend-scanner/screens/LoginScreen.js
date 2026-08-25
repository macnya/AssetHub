import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, Image } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from '../api';
import { clearReauthFlag } from '../offline/syncManager';

export default function LoginScreen({ onLoginSuccess }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!email || !password) {
      Alert.alert('Missing info', 'Please enter both email and password.');
      return;
    }

    setLoading(true);
    try {
      const response = await api.post('/auth/login', {
        email: email.trim().toLowerCase(),
        password,
      });
      await AsyncStorage.setItem('token', response.data.token);
      // The user record was never stored, so App.js always read back null
      // and the home screen greeting was permanently blank.
      if (response.data.user) {
        await AsyncStorage.setItem('user', JSON.stringify(response.data.user));
      }
      // A fresh token means any queued work can be retried.
      clearReauthFlag();
      onLoginSuccess();
    } catch (err) {
      const message = err.response?.data?.error || 'Login failed. Check your connection.';
      Alert.alert('Login failed', message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Image source={require('../assets/logo.png')} style={styles.logo} resizeMode="contain" />
      <Text style={styles.title}>AssetHub{'\n'}Scanner</Text>

      <TextInput
        style={styles.input}
        placeholder="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        placeholderTextColor="#98A1AE"
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        placeholderTextColor="#98A1AE"
      />

      <TouchableOpacity style={styles.button} onPress={handleLogin} disabled={loading}>
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Log In</Text>}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24 },
  logo: { width: 220, height: 57, alignSelf: 'center', marginBottom: 24 },
  title: { fontSize: 24, fontWeight: 'bold', textAlign: 'center', marginBottom: 40 },
  input: {
    borderWidth: 1, borderColor: '#E4E7EC', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 13, marginBottom: 14, fontSize: 16,
    // Explicit, because Android tints input text for the system theme and the
    // card behind it is hardcoded white — white on white is invisible.
    color: '#14181F', backgroundColor: '#FFFFFF',
  },
  button: {
    backgroundColor: '#0A3D4A', borderRadius: 8, padding: 16, alignItems: 'center',
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});